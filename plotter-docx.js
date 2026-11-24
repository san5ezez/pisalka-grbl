async function docxPart(buffer, part) {
    const view = new DataView(buffer);
    const u16 = p => view.getUint16(p, true);
    const u32 = p => view.getUint32(p, true);
    let end = view.byteLength - 22;
    while (end >= Math.max(0, view.byteLength - 65557) &&
        (u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== view.byteLength)) end--;
    if (end < Math.max(0, view.byteLength - 65557)) throw Error('Не удалось открыть архив DOCX.');
    let cursor = u32(end + 16);
    for (let i = 0; i < u16(end + 10); i++) {
        if (cursor + 46 > end || u32(cursor) !== 0x02014b50) break;
        const nameLen = u16(cursor + 28);
        const name = new TextDecoder().decode(buffer.slice(cursor + 46, cursor + 46 + nameLen));
        if (name === part) {
            if ((u16(cursor + 8) & 1) || u32(cursor + 24) > 8_000_000) throw Error('Документ защищён или слишком велик.');
            const offset = u32(cursor + 42);
            if (offset + 30 > view.byteLength || u32(offset) !== 0x04034b50) throw Error('Повреждённый DOCX.');
            const start = offset + 30 + u16(offset + 26) + u16(offset + 28);
            const length = u32(cursor + 20);
            if (start + length > view.byteLength) throw Error('Повреждённый DOCX.');
            const bytes = new Uint8Array(buffer, start, length);
            if (u16(cursor + 10) === 0) return bytes;
            if (u16(cursor + 10) !== 8 || !('DecompressionStream' in window)) throw Error('Открой DOCX в актуальном Chrome или Edge.');
            const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
            const chunks = [];
            let size = 0;
            while (true) {
                const {done, value} = await reader.read();
                if (done) return new Uint8Array(await new Blob(chunks).arrayBuffer());
                size += value.length;
                if (size > 8_000_000) {
                    await reader.cancel();
                    throw Error('Документ слишком велик.');
                }
                chunks.push(value);
            }
        }
        cursor += 46 + nameLen + u16(cursor + 30) + u16(cursor + 32);
    }
    return null;
}

const docxBlocks = Object.create(null);
try { Object.assign(docxBlocks, JSON.parse(localStorage.getItem('plotter_docx_blocks') || '{}')); } catch {}
const docxMarker = /^\[DOCX:(\d+)\]$/;

function docxBlock(line) {
    return docxBlocks[docxMarker.exec(line.trim())?.[1]];
}

function readDocxXML(bytes) {
    if (!bytes) return null;
    const xml = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
    if (xml.querySelector('parsererror')) throw Error('Не удалось прочитать XML DOCX.');
    return xml;
}

function paragraphText(p) {
    return Array.from(p.getElementsByTagNameNS('*', '*')).map(node => {
        if (!/wordprocessingml|officeDocument.*math/.test(node.namespaceURI || '')) return '';
        if (node.localName === 't') return node.textContent;
        if (node.localName === 'tab') return ' ';
        if (node.localName === 'br') return '\n';
        return '';
    }).join('');
}

function traceDocxPixels(data, w, h) {
    const dark = (x, y) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return false;
        const i = (y*w+x)*4;
        return data[i+3] > 100 && (data[i]+data[i+1]+data[i+2])/3 < 170;
    };
    const edges = new Map(), stride = w+1;
    function edge(x, y, a, b) {
        const from = y*stride+x, to = b*stride+a;
        if (!edges.has(from)) edges.set(from, []);
        edges.get(from).push(to);
    }
    for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
        if (!dark(x,y)) continue;
        if (!dark(x,y-1)) edge(x,y,x+1,y);
        if (!dark(x+1,y)) edge(x+1,y,x+1,y+1);
        if (!dark(x,y+1)) edge(x+1,y+1,x,y+1);
        if (!dark(x-1,y)) edge(x,y+1,x,y);
    }
    const paths=[];
    while (edges.size) {
        const start=edges.keys().next().value;
        let current=start;
        const path=[];
        do {
            const x=current%stride, y=Math.floor(current/stride);
            const a=path.at(-2), b=path.at(-1);
            if (a && (b[0]-a[0])*(y-b[1]) === (b[1]-a[1])*(x-b[0])) path.pop();
            path.push([x,y]);
            const next=edges.get(current);
            if (!next) break;
            const from=current;
            current=next.pop();
            if (!next.length) edges.delete(from);
        } while (current!==start);
        if (current===start) path.push(path[0]);
        if (path.length>=5) paths.push(path);
    }
    return {type:'image', paths, w, h};
}

async function traceDocxImage(bytes) {
    const image = await createImageBitmap(new Blob([bytes]));
    try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 360/Math.max(image.width,image.height));
        const w=canvas.width=Math.max(1,Math.round(image.width*scale));
        const h=canvas.height=Math.max(1,Math.round(image.height*scale));
        const ctx=canvas.getContext('2d');
        ctx.drawImage(image,0,0,w,h);
        return traceDocxPixels(ctx.getImageData(0,0,w,h).data,w,h);
    } finally { image.close(); }
}

async function importDocx(buffer) {
    const doc=readDocxXML(await docxPart(buffer,'word/document.xml'));
    if (!doc) throw Error('В DOCX отсутствует основной текст.');
    const rels=readDocxXML(await docxPart(buffer,'word/_rels/document.xml.rels'));
    const targets=new Map(Array.from(rels?.getElementsByTagNameNS('*','Relationship') || [])
        .filter(el=>el.getAttribute('Type')?.endsWith('/image') && el.getAttribute('TargetMode')!=='External')
        .map(el=>[el.getAttribute('Id'),el.getAttribute('Target').replace(/^\/?word\//,'')]));
    const lines=[], blocks=[];
    let skipped=0, images=0, tables=0;
    let next=Date.now()*100;
    function add(block) {
        const key=String(next++);
        blocks.push([key,block]);
        lines.push('[DOCX:'+key+']');
    }
    const body=doc.getElementsByTagNameNS('*','body')[0];
    if (!body) throw Error('Не удалось прочитать содержимое DOCX.');
    for (const node of body.children) {
        if (node.localName==='p') {
            const text=paragraphText(node);
            if (text.trim()) lines.push(text);
            for (const image of node.getElementsByTagNameNS('*','blip')) {
                const id=Array.from(image.attributes).find(a=>a.localName==='embed')?.value;
                const target=targets.get(id);
                if (!target?.startsWith('media/') || target.includes('..') || images>=40) { skipped++; continue; }
                try {
                    const bytes=await docxPart(buffer,'word/'+target);
                    const block=await traceDocxImage(bytes);
                    if (!block.paths.length) throw Error('Пустое изображение');
                    add(block);
                    images++;
                } catch { skipped++; }
            }
        } else if (node.localName==='tbl') {
            const rows=Array.from(node.children).filter(el=>el.localName==='tr').map(row=>
                Array.from(row.children).filter(el=>el.localName==='tc').map(cell=>paragraphText(cell).trim()));
            if (rows.length) { add({type:'table',rows}); tables++; }
        }
    }
    return {lines,blocks,images,tables,skipped};
}

function layoutDocxBlock(block, width, maxHeight) {
    if (block.type==='image') {
        const scale=Math.min(width*.65/block.w, 38/block.h, maxHeight/block.h);
        return {height:block.h*scale, paths:block.paths.map(path=>path.map(([x,y])=>[(width-block.w*scale)/2+x*scale,y*scale]))};
    }
    const cols=Math.max(...block.rows.map(row=>row.length));
    const cw=width/cols, rh=Math.min(8,maxHeight/block.rows.length);
    const h=rh*block.rows.length;
    const paths=[];
    for (let row=0;row<=block.rows.length;row++) paths.push([[0,row*rh],[width,row*rh]]);
    for (let col=0;col<=cols;col++) paths.push([[col*cw,0],[col*cw,h]]);
    block.rows.forEach((row,r)=>row.forEach((text,c)=>{
        const chars=Array.from(text);
        const size=Math.min(rh*.55, cw*.88/Math.max(1,chars.reduce((n,ch)=>n+getCharWidth(ch)+.08,0)));
        let x=c*cw+cw*.06;
        for (const ch of chars) {
            const advance=getCharWidth(ch)*size;
            for (const stroke of getCharGlyph(ch) || []) {
                if (stroke.length>1) paths.push(stroke.map(([a,b])=>[x+a*advance,(r+.77)*rh-b*size]));
            }
            x+=advance+size*.08;
        }
    }));
    return {height:h,paths};
}

document.getElementById('docxInput').addEventListener('change', async event => {
    const input=event.currentTarget;
    const file=input.files[0];
    input.value='';
    if (!file) return;
    input.disabled=true;
    try {
        if (file.size>25_000_000) throw Error('Выбери DOCX размером до 25 МБ.');
        const result=await importDocx(await file.arrayBuffer());
        if (!result.lines.length) throw Error('Не найдено содержимое для импорта.');
        const summary=`Рисунков: ${result.images}. Таблиц: ${result.tables}. Пропущено рисунков: ${result.skipped}.`;
        if (!confirm(summary+' Добавить содержимое в конец текущего текста?')) return;
        const editor=document.getElementById('textInput');
        Object.assign(docxBlocks,Object.fromEntries(result.blocks));
        editor.value+=(editor.value.trim()?'\n\n':'')+result.lines.join('\n');
        try { localStorage.setItem('plotter_docx_blocks',JSON.stringify(docxBlocks)); }
        catch { alert('Рисунки доступны до обновления страницы. Скачай NC сейчас, память браузера заполнена.'); }
        render();
    } catch (error) {
        alert('DOCX: '+error.message);
    } finally { input.disabled=false; }
});

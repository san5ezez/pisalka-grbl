async function docxDocument(buffer) {
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
        if (name === 'word/document.xml') {
            if ((u16(cursor + 8) & 1) || u32(cursor + 24) > 8_000_000) throw Error('Документ защищён или слишком велик.');
            const offset = u32(cursor + 42);
            if (offset + 30 > view.byteLength || u32(offset) !== 0x04034b50) throw Error('Повреждённый DOCX.');
            const start = offset + 30 + u16(offset + 26) + u16(offset + 28);
            const length = u32(cursor + 20);
            if (start + length > view.byteLength) throw Error('Повреждённый DOCX.');
            const bytes = new Uint8Array(buffer, start, length);
            if (u16(cursor + 10) === 0) return new TextDecoder().decode(bytes);
            if (u16(cursor + 10) !== 8 || !('DecompressionStream' in window)) throw Error('Открой DOCX в актуальном Chrome или Edge.');
            const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
            const decoder = new TextDecoder();
            let size = 0, xml = '';
            while (true) {
                const {done, value} = await reader.read();
                if (done) return xml + decoder.decode();
                size += value.length;
                if (size > 8_000_000) {
                    await reader.cancel();
                    throw Error('Документ слишком велик.');
                }
                xml += decoder.decode(value, {stream:true});
            }
        }
        cursor += 46 + nameLen + u16(cursor + 30) + u16(cursor + 32);
    }
    throw Error('В DOCX отсутствует основной текст.');
}

function docxParagraphs(xml) {
    const document = new DOMParser().parseFromString(xml, 'application/xml');
    if (document.querySelector('parsererror')) throw Error('Не удалось прочитать текст DOCX.');
    return Array.from(document.getElementsByTagNameNS('*', 'p')).map(p =>
        Array.from(p.getElementsByTagNameNS('*', '*')).map(node => {
            if (!/wordprocessingml|purl\.oclc\.org\/ooxml\/wordprocessingml/.test(node.namespaceURI || '')) return '';
            if (node.localName === 't') return node.textContent;
            if (node.localName === 'tab') return ' ';
            if (node.localName === 'br') return '\n';
            return '';
        }).join('')
    ).join('\n');
}

document.getElementById('docxInput').addEventListener('change', async event => {
    const input = event.currentTarget;
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    try {
        if (file.size > 25_000_000) throw Error('Выбери DOCX размером до 25 МБ.');
        const text = docxParagraphs(await docxDocument(await file.arrayBuffer()));
        if (!text.trim()) throw Error('В документе нет обычного текста для импорта.');
        const editor = document.getElementById('textInput');
        if (!confirm('Импортировать абзацы DOCX? Текст добавится в конец. Оформление и рисунки Word пропускаются.')) return;
        editor.value += (editor.value.trim() ? '\n\n' : '') + text;
        render();
    } catch (error) {
        alert('DOCX: ' + error.message);
    }
});

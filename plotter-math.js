const byId = id => document.getElementById(id);
const modes = {
    graph: ['Функция от x. Диапазон обеих осей: от −5 до 5.', 'x^2 / 3 - 2'],
    bars: ['Значения столбцов через пробел или с новой строки.', '3 7 5 9'],
    flow: ['По одному номеру блока на строку.', '1\n2\n3'],
    solve: ['Арифметический пример. Поддерживаются скобки, +, −, ×, ÷ и степени.', '(8 + 4) / 3']
};

function expression(source) {
    const clean = source.replace(/[−–]/g, '-').replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/\s/g, '');
    const tokens = clean.match(/\d+(?:[.,]\d+)?|[x()+*/^\-]/g) || [];
    if (!tokens.length || tokens.join('') !== clean || tokens.length > 160) throw Error('Проверь выражение.');
    let i = 0;
    const priority = {'+': 1, '-': 1, '*': 2, '/': 2, '^': 4};
    function parse(min) {
        const token = tokens[i++];
        let left;
        if (token === '(') {
            left = parse(0);
            if (tokens[i++] !== ')') throw Error('Не хватает закрывающей скобки.');
        } else if (token === '+' || token === '-') {
            left = {op: token === '-' ? 'neg' : 'pos', right: parse(3)};
        } else if (token === 'x' || /^\d/.test(token || '')) {
            left = {value: token === 'x' ? token : Number(token.replace(',', '.'))};
        } else throw Error('Ожидается число, x или скобка.');
        while (priority[tokens[i]] >= min) {
            const op = tokens[i++];
            left = {op, left, right: parse(priority[op] + (op === '^' ? 0 : 1))};
        }
        return left;
    }
    const tree = parse(0);
    if (i !== tokens.length) throw Error('Между числами нужен знак действия.');
    return tree;
}

function evaluate(node, x, steps) {
    if ('value' in node) return node.value === 'x' ? x : node.value;
    const a = node.left && evaluate(node.left, x, steps);
    const b = evaluate(node.right, x, steps);
    const op = node.op;
    const result = op === 'neg' ? -b : op === 'pos' ? b : op === '+' ? a+b :
        op === '-' ? a-b : op === '*' ? a*b : op === '/' ? a/b : a**b;
    if (steps) {
        if (!Number.isFinite(result)) throw Error('Результат не определён или слишком велик.');
        steps.push(op === 'neg' || op === 'pos' ? pretty(result) : `${pretty(a)}${op}${pretty(b)}=${pretty(result)}`);
    }
    return result;
}

function pretty(value) {
    return Number(value.toPrecision(9)).toString().replace('e', 'E');
}

const segments = [[[0,0],[4,0]],[[4,0],[4,4]],[[4,4],[4,8]],[[0,8],[4,8]],[[0,4],[0,8]],[[0,0],[0,4]],[[0,4],[4,4]]];
const shapes = ['012345','12','01346','01236','1256','02356','023456','012','0123456','012356'];
const marks = {
    '-': [[[0,4],[4,4]]], '+': [[[0,4],[4,4]],[[2,2],[2,6]]],
    '=': [[[0,3],[4,3]],[[0,5],[4,5]]], '.': [[[2,8],[2.6,8]]],
    '*': [[[0,2],[4,6]],[[0,6],[4,2]]], '/': [[[0,8],[4,0]]],
    '^': [[[0,4],[2,1],[4,4]]], E: [[[4,0],[0,0],[0,8],[4,8]],[[0,4],[3,4]]]
};
function letters(text, x, y, scale) {
    return [...text].flatMap((ch,i) => {
        const lines = shapes[ch] ? [...shapes[ch]].map(n=>segments[n]) : marks[ch] || [];
        return lines.map(line=>line.map(([a,b])=>[x+(a+i*6)*scale,y+b*scale]));
    });
}
const rect = (x,y,w,h) => [[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]];

function drawing(kind, input) {
    const paths = [];
    if (kind === 'graph') {
        const tree = expression(input);
        paths.push([[10,40],[110,40]],[[60,5],[60,75]]);
        for (let i=-5;i<=5;i++) {
            paths.push([[60+i*10,39],[60+i*10,41]],[[59,40-i*7],[61,40-i*7]]);
        }
        let stroke = [];
        for (let i=0;i<=400;i++) {
            const x = i/40-5, y = evaluate(tree,x);
            if (Number.isFinite(y) && Math.abs(y)<=5 && (!stroke.length || Math.abs(stroke.at(-1)[1]-(40-y*7))<25)) {
                stroke.push([60+x*10,40-y*7]);
            } else {
                if (stroke.length>1) paths.push(stroke);
                stroke=[];
            }
        }
        if (stroke.length>1) paths.push(stroke);
        if (paths.length === 24) throw Error('График не виден в диапазоне от −5 до 5.');
    } else if (kind === 'bars') {
        const values=input.trim().split(/\s+/).map(s=>Number(s.replace(',','.')));
        if (!input.trim() || values.length>10 || values.some(v=>!Number.isFinite(v)||v<0) || !Math.max(...values)) throw Error('Введи от 1 до 10 неотрицательных чисел, хотя бы одно больше нуля.');
        const slot=100/values.length;
        paths.push([[10,65],[110,65]]);
        values.forEach((v,i)=>{
            const h=45*v/Math.max(...values), x=10+i*slot+slot*.15;
            if (h>0) paths.push(rect(x,65-h,slot*.7,h));
            paths.push(...letters(String(i+1),x,68,.65));
            const label = pretty(v);
            paths.push(...letters(label,x,58-h,Math.min(.6,slot/(label.length*6))));
        });
    } else if (kind === 'flow') {
        const labels=input.trim().split(/\n/).map(x=>x.trim());
        if (labels.length>8 || labels.some(x=>!/^\d{1,6}$/.test(x))) throw Error('Введи от 1 до 8 номеров блоков, максимум 6 цифр в каждом.');
        const w=100/labels.length, box=w*.74;
        labels.forEach((label,i)=>{
            const x=10+i*w, scale=Math.min(1,box/(label.length*7));
            paths.push(rect(x,29,box,20),...letters(label,x+(box-label.length*6*scale)/2,35,scale));
            if (i<labels.length-1) {
                const end=x+w;
                paths.push([[x+box,39],[end,39]],[[end-2,37],[end,39],[end-2,41]]);
            }
        });
    } else {
        const steps=[];
        const result = evaluate(expression(input),NaN,steps);
        if (!Number.isFinite(result)) throw Error('Для примера используй числа.');
        if (!steps.length) steps.push(pretty(result));
        if (steps.length>18) throw Error('Разбей длинное решение на несколько примеров.');
        const scale=Math.min(1.3, 65/(10*steps.length), 100/(6*Math.max(...steps.map(s=>s.length))));
        steps.forEach((line,i)=>paths.push(...letters(line,10,8+i*10*scale,scale)));
    }
    return paths;
}

const canvas=document.querySelector('canvas'), ctx=canvas.getContext('2d');
let paths=[];
function refresh() {
    ctx.clearRect(0,0,720,480);
    try {
        paths=drawing(byId('kind').value,byId('source').value);
        ctx.strokeStyle='#16284e';
        ctx.lineWidth=2;
        ctx.beginPath();
        for (const path of paths) path.forEach(([x,y],i)=>i ? ctx.lineTo(x*6,y*6) : ctx.moveTo(x*6,y*6));
        ctx.stroke();
        const rotated=byId('rotation').value==='90';
        byId('status').textContent=rotated ? 'Поле NC: 80 × 120 мм. Длинная сторона по Y.' : 'Поле NC: 120 × 80 мм.';
        byId('download').disabled=false;
    } catch(error) {
        paths=[];
        byId('status').textContent=error.message;
        byId('download').disabled=true;
    }
}
function selectMode() {
    const [hint,sample]=modes[byId('kind').value];
    byId('hint').textContent=hint;
    byId('source').value=sample;
    refresh();
}
function buildMathNC(paths, rotated, settings) {
    const up = `G1 Z${settings.up} F1200`;
    const down = `G1 Z${settings.down} F1200`;
    const move=([x,y],feed)=>`G1 X${(rotated?y:x).toFixed(3)} Y${(rotated?x:80-y).toFixed(3)} F${feed}`;
    const lines=['G90','G21',up];
    for (const path of paths) {
        lines.push(move(path[0],settings.rapid),down);
        for (const point of path.slice(1)) lines.push(move(point,settings.draw));
        lines.push(up);
    }
    lines.push('G1 X0 Y0 F'+settings.rapid);
    return lines.join('\n')+'\n';
}
byId('kind').onchange=selectMode;
byId('source').oninput=refresh;
byId('rotation').onchange=refresh;
byId('download').onclick=()=>{
    let saved={};
    try { saved=JSON.parse(localStorage.getItem('plotter_settings_pro') || '{}') || {}; } catch {}
    const value=(key,fallback)=>saved[key] !== '' && Number.isFinite(Number(saved[key])) ? Number(saved[key]) : fallback;
    const settings={up:value('zUp',-8),down:value('zDown',0),rapid:Math.max(1,value('fRapid',1000)),draw:Math.max(1,value('fDraw',1000))};
    if (settings.up===settings.down) {
        byId('status').textContent='Задай разные высоты подъёма и опускания в редакторе текста.';
        return;
    }
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([buildMathNC(paths,byId('rotation').value==='90',settings)],{type:'text/plain'}));
    a.download=byId('kind').value+'.nc';
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);
};
selectMode();

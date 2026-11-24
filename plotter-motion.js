const motionPanel = document.getElementById('motionPanel');
const motionCanvas = document.getElementById('motionCanvas');
const readout = document.getElementById('headReadout');
const jogButtons = [...document.querySelectorAll('[data-jog]')];
const cancelJogButton = document.getElementById('cancelJog');
let workOffset = null;
let head = null;
let machineState = '';
let trace = [];
let lastStatus = 0;

function resetMotionConnection() {
    workOffset = null;
    head = null;
    machineState = '';
    lastStatus = 0;
    trace = [];
}

function trackGRBL(report) {
    const [state, ...fields] = report.slice(1, -1).split('|');
    machineState = state.split(':')[0];
    lastStatus = performance.now();
    const coordinates = name => {
        const values = fields.find(field => field.startsWith(name + ':'))?.split(':')[1].split(',').slice(0, 3).map(Number);
        return values?.length === 3 && values.every(Number.isFinite) ? values : null;
    };
    const offset = coordinates('WCO');
    if (offset && workOffset && offset.some((value, index) => value !== workOffset[index])) trace = [];
    if (offset) workOffset = offset;
    const machine = coordinates('MPos');
    const next = coordinates('WPos') || (machine && workOffset && machine.map((value, index) => value - workOffset[index]));
    if (next && (!head || next.some((value, index) => value !== head[index]))) {
        head = next;
        trace.push(next);
        if (trace.length > 3000) trace.shift();
    }
    refreshMotion();
}

function showMotion(visible) {
    motionPanel.hidden = !visible;
    refreshMotion();
}

function clearMotion() {
    trace = head ? [head] : [];
    refreshMotion();
}

function refreshMotion() {
    const fresh = Boolean(serialWriter && lastStatus && performance.now() - lastStatus < 1200);
    const idle = fresh && machineState === 'Idle';
    jogButtons.forEach(button => { button.disabled = !idle || running || connecting || Boolean(window.jogBusy); });
    cancelJogButton.disabled = !serialWriter || running || (machineState !== 'Jog' && !window.jogBusy);
    if (motionPanel.hidden) return;
    readout.textContent = fresh
        ? (head ? `${machineState} · X ${head[0].toFixed(2)} · Y ${head[1].toFixed(2)} · Z ${head[2].toFixed(2)} мм` : `${machineState} · ожидаю рабочие координаты`)
        : (serialWriter ? 'Ожидаю координаты GRBL…' : 'Подключи USB для отображения позиции.');

    const plan = machinePaths(pagesData[currentPageIndex]?.paths ?? []);
    let minX = 0, minY = 0, maxX = 1, maxY = 1;
    function include(x, y) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    for (const path of plan) for (const point of path) include(point.x, point.y);
    for (const [x, y] of trace) include(x, y);
    const {width, height} = motionCanvas;
    const scale = Math.min((width - 36) / (maxX - minX), (height - 36) / (maxY - minY));
    const screen = (x, y) => [18 + (x - minX) * scale, height - 18 - (y - minY) * scale];
    const ctx = motionCanvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#78849a';
    ctx.beginPath();
    for (const path of plan) path.forEach(({x, y}, i) => {
        if (i === 0) ctx.moveTo(...screen(x, y));
        else ctx.lineTo(...screen(x, y));
    });
    ctx.stroke();
    ctx.strokeStyle = '#40d8a8';
    ctx.beginPath();
    trace.forEach(([x, y], i) => {
        if (i === 0) ctx.moveTo(...screen(x, y));
        else ctx.lineTo(...screen(x, y));
    });
    ctx.stroke();
    ctx.fillStyle = '#99a8c4';
    ctx.fillText('0', ...screen(0, 0));
    if (fresh && head) {
        ctx.beginPath();
        ctx.arc(...screen(head[0], head[1]), 5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffca66';
        ctx.fill();
    }
}

async function jogStep(axis, direction) {
    if (!serialWriter || running || connecting || window.jogBusy || waiting ||
        machineState !== 'Idle' || performance.now() - lastStatus >= 1200) return;
    const step = Number(document.getElementById(axis === 'Z' ? 'jogZStep' : 'jogStep').value);
    window.jogBusy = true;
    updateUSB();
    try {
        await exchange(`$J=G91 G21 ${axis}${step * direction} F${axis === 'Z' ? 200 : 500}\n`, line => line === 'ok');
        machineState = 'Jog';
    } catch (error) {
        usbStatus.textContent = 'Джойстик: ' + error.message;
    } finally {
        window.jogBusy = false;
        updateUSB();
    }
}

for (const button of jogButtons) {
    const [axis, direction] = button.dataset.jog.split(',');
    button.addEventListener('click', () => jogStep(axis, Number(direction)));
}
cancelJogButton.addEventListener('click', async () => {
    if (!serialWriter || running) return;
    try { await serialWriter.write(Uint8Array.of(0x85)); }
    catch (error) { usbStatus.textContent = 'Джойстик: ' + error.message; }
});

setInterval(() => {
    if (serialWriter && !connecting && !waiting) {
        serialWriter.write(encoder.encode('?')).catch(() => {});
    }
    if (lastStatus && performance.now() - lastStatus >= 1200) refreshMotion();
}, 250);
refreshMotion();

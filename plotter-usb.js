const usbStatus = document.getElementById('usbStatus');
const usbButton = document.getElementById('btnUsbSerial');
const sendButton = document.getElementById('sendJob');
const holdButton = document.getElementById('holdJob');
const encoder = new TextEncoder();
let waiting = null;
let running = false;
let held = false;
let connecting = false;
let readTask;

async function loadFontPreset(name) {
    if (!['handwritten', 'van-dijk'].includes(name)) {
        if (!name) resetDefaultFont();
        return;
    }
    try {
        const response = await fetch(`fonts/${name}.svg`);
        if (!response.ok) throw new Error('файл не найден');
        const file = new File([await response.blob()], `${name}.svg`);
        if (document.getElementById('fontPreset').value !== name) return;
        // Reuse the upstream importer for built-in and uploaded SVG fonts.
        const input = document.getElementById('svgFontInput');
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event('change'));
    } catch (error) {
        usbStatus.textContent = 'Ошибка загрузки шрифта: ' + error.message;
    }
}

function updateUSB() {
    usbButton.textContent = serialWriter ? 'Отключить USB' : 'Подключить USB';
    usbButton.disabled = running || connecting;
    sendButton.disabled = !serialWriter || running || connecting;
    holdButton.disabled = !running || connecting;
    holdButton.textContent = held ? 'Продолжить' : 'Пауза';
}

async function readUSB(reader) {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, {stream: true});
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines.map(text => text.trim())) {
                if (/^(error:|ALARM:|Grbl )/i.test(line)) waiting?.reject(new Error(line));
                else if (waiting?.match(line)) waiting.resolve(line);
            }
        }
    } catch (error) {
        waiting?.reject(error);
    } finally {
        waiting?.reject(new Error('USB отключён'));
        reader.releaseLock();
    }
}

function exchange(command, match) {
    return new Promise((resolve, reject) => {
        let activeSeconds = 0;
        const timer = setInterval(() => {
            if (!held && ++activeSeconds >= 15) finish(reject, new Error('GRBL не ответил'));
        }, 1000);
        function finish(callback, value) {
            clearInterval(timer);
            waiting = null;
            callback(value);
        }
        waiting = {match, resolve: line => finish(resolve, line), reject: err => finish(reject, err)};
        serialWriter.write(encoder.encode(command)).catch(error => waiting?.reject(error));
    });
}

let usbReader;
async function closeUSB() {
    await usbReader?.cancel().catch(() => {});
    await readTask;
    serialWriter?.releaseLock();
    await serialPort?.close().catch(() => {});
    usbReader = null;
    serialWriter = null;
    serialPort = null;
    readTask = null;
}

async function toggleUSBConnection() {
    if (!navigator.serial) {
        usbStatus.textContent = 'Для USB открой страницу в Chrome или Edge.';
        return;
    }
    connecting = true;
    updateUSB();
    try {
        if (serialWriter) {
            await closeUSB();
            usbStatus.textContent = 'USB отключён';
        } else {
            serialPort = await navigator.serial.requestPort();
            await serialPort.open({baudRate: 115200});
            serialWriter = serialPort.writable.getWriter();
            usbReader = serialPort.readable.getReader();
            readTask = readUSB(usbReader);
            await new Promise(resolve => setTimeout(resolve, 1500));
            const status = await exchange('?', line => line.startsWith('<'));
            usbStatus.textContent = 'GRBL: ' + status.slice(1).split(/[|>]/)[0];
        }
    } catch (error) {
        await closeUSB();
        usbStatus.textContent = 'USB: ' + error.message;
    } finally {
        connecting = false;
        updateUSB();
    }
}

async function holdJob() {
    if (!running || !serialWriter) return;
    try {
        await serialWriter.write(encoder.encode(held ? '~' : '!'));
        held = !held;
        usbStatus.textContent = held ? 'Пауза' : 'Выполняется';
        updateUSB();
    } catch (error) {
        waiting?.reject(error);
    }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sendJob() {
    if (running || connecting || !serialWriter) return;
    const paths = pagesData[currentPageIndex]?.paths;
    if (!paths?.length) {
        usbStatus.textContent = 'На странице нет текста.';
        return;
    }
    const zUp = numVal('zUp', -8);
    const zDown = numVal('zDown', 0);
    if (zUp === zDown || ['fDraw', 'fRapid'].some(id => numVal(id, 0) <= 0)) {
        usbStatus.textContent = 'Проверь высоты пера и скорость.';
        return;
    }
    const {minX, minY, maxX, maxY} = machineBounds(paths);
    if (!confirm(`Страница ${currentPageIndex + 1}.\nX: ${minX.toFixed(1)}…${maxX.toFixed(1)} мм, Y: ${minY.toFixed(1)}…${maxY.toFixed(1)} мм от рабочего нуля.\nПеро: вверх ${zUp}, вниз ${zDown}.\nНачать письмо?`)) return;
    const lines = buildGCodeText(paths, currentPageIndex + 1).split('\n').slice(1);
    running = true;
    held = false;
    updateUSB();
    try {
        const status = await exchange('?', line => line.startsWith('<'));
        if (!/^<Idle[|>]/.test(status)) throw new Error('Для старта GRBL должен быть в состоянии Idle.');
        for (const [index, line] of lines.entries()) {
            while (held) await delay(100);
            await exchange(line + '\n', response => response === 'ok');
            if (index % 10 === 0 && !held) usbStatus.textContent = `Отправка ${Math.round((index + 1) / lines.length * 100)}%`;
        }
        for (;;) {
            while (held) await delay(100);
            const status = await exchange('?', line => line.startsWith('<'));
            if (/^<Idle[|>]/.test(status)) break;
            if (/^<Alarm[|>]/i.test(status)) throw new Error('GRBL в состоянии Alarm');
            await delay(250);
        }
        usbStatus.textContent = 'Страница готова';
    } catch (error) {
        if (/не ответил/.test(error.message)) {
            await serialWriter.write(encoder.encode('!')).catch(() => {});
            await closeUSB();
        }
        usbStatus.textContent = 'Отправка прервана: ' + error.message;
    } finally {
        running = false;
        held = false;
        updateUSB();
    }
}

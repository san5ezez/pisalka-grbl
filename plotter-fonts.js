const fontSelect = document.getElementById('fontPreset');
const fontMessage = document.getElementById('fontStatus');
const localFontGroup = document.getElementById('localFontGroup');
const localFonts = new Map();
const fontCache = new Map();
let fontRequest = 0;

function addLocalFont(name, source) {
    const key = 'local:' + name;
    if (!localFonts.has(key)) localFontGroup.append(new Option(name, key));
    localFonts.set(key, source);
    return key;
}

function restoreFonts() {
    let saved = '';
    try {
        saved = JSON.parse(localStorage.getItem('plotter_settings_pro') || '{}').fontPreset || '';
        if (saved === 'handwritten' || saved === 'van-dijk') saved += '.svg';
        const entries = JSON.parse(localStorage.getItem('plotter_local_fonts') || '[]');
        for (const [key, source] of entries) addLocalFont(key.slice(6), source);
    } catch (error) {
        fontMessage.textContent = 'Не удалось восстановить загруженные шрифты.';
    }
    fontSelect.value = saved;
    if (fontSelect.selectedIndex < 0) fontSelect.value = '';
    loadFontPreset(fontSelect.value);
}

async function loadFontPreset(key) {
    const request = ++fontRequest;
    if (!key) {
        fontMessage.textContent = '';
        resetDefaultFont();
        return;
    }
    const label = fontSelect.selectedOptions[0]?.textContent || key;
    fontMessage.textContent = 'Загрузка…';
    try {
        if (!fontCache.has(key)) {
            let svg = localFonts.get(key);
            if (!svg) {
                const url = 'fonts/' + key.split('/').map(encodeURIComponent).join('/');
                const response = await fetch(url);
                if (!response.ok) throw new Error('файл недоступен');
                svg = await response.text();
            }
            if (request !== fontRequest || key !== fontSelect.value) return;
            fontCache.set(key, parseFontSVG(svg));
        }
        const parsed = fontCache.get(key);
        customFont = parsed.font;
        customWidths = parsed.widths;
        const cyrillic = Object.keys(parsed.font).some(ch => /[а-яё]/i.test(ch));
        fontMessage.textContent = `${parsed.count} знаков${cyrillic ? ' · кириллица' : ' · для русских букв используется встроенный почерк'}`;
        updateFontUI('Загрузить SVG');
    } catch (error) {
        if (request !== fontRequest || key !== fontSelect.value) return;
        resetDefaultFont();
        fontMessage.textContent = `${label}: ${error.message}`;
    }
}

async function importLocalFonts(input) {
    const errors = [];
    let selected;
    for (const file of input.files) {
        try {
            const source = await file.text();
            const parsed = parseFontSVG(source);
            selected = addLocalFont(file.name.replace(/\.svg$/i, ''), source);
            fontCache.set(selected, parsed);
        } catch (error) {
            errors.push(file.name + ': ' + error.message);
        }
    }
    input.value = '';
    if (selected) {
        try {
            localStorage.setItem('plotter_local_fonts', JSON.stringify([...localFonts]));
        } catch (error) {
            errors.push('Хранилище заполнено. Новые шрифты доступны до закрытия вкладки.');
        }
        fontSelect.value = selected;
        await loadFontPreset(selected);
    }
    if (errors.length) fontMessage.textContent = errors.join(' · ');
}

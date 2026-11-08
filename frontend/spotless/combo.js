// Type-to-filter dropdowns. enhanceSelect(select) puts a look-alike field in
// front of a <select>: clicking it opens the option list, and typing filters
// the list (every typed word must appear, in any order, any case). Arrow keys
// and Enter pick, Esc or a click elsewhere closes.
//
// The <select> stays the source of truth: its options (and optgroups),
// `.value`, `hidden`, `disabled` and `change` events work as before, so the
// code that fills and reads it doesn't change. Options can be replaced at any
// time; the field follows.

// `items`: [{ text, value, group, disabled }]. Returns the ones matching the query.
export function filterItems(items, query) {
    const words = normalize(query).split(' ').filter(Boolean);
    if (words.length === 0) return items;
    return items.filter(item => words.every(w => normalize(`${item.group ?? ''} ${item.text}`).includes(w)));
}

// Lower case, LRM marks (see endFirst) and extra spaces removed.
function normalize(text) {
    return String(text ?? '').replace(/‎/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const clean = (text) => String(text ?? '').replace(/‎/g, '');

// The select's options, in order, with their optgroup label.
function readItems(select) {
    const items = [];
    for (const child of select.children) {
        if (child.tagName === 'OPTGROUP') {
            for (const option of child.children) {
                items.push({ text: clean(option.text), value: option.value, group: child.label, disabled: option.disabled || child.disabled });
            }
        } else if (child.tagName === 'OPTION') {
            items.push({ text: clean(child.text), value: child.value, group: null, disabled: child.disabled });
        }
    }
    return items;
}

let nextId = 0;

export function enhanceSelect(select) {
    const id = select.id || `combo-${++nextId}`;
    const wrap = document.createElement('div');
    wrap.className = 'combo';
    wrap.id = `${id}-combo`;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = `combo-input ${select.className}`.trim();
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', `${id}-list`);
    input.setAttribute('aria-label', select.getAttribute('aria-label') ?? '');

    const list = document.createElement('div');
    list.className = 'combo-list';
    list.id = `${id}-list`;
    list.setAttribute('role', 'listbox');
    list.hidden = true;

    wrap.append(input, list);
    select.after(wrap);
    select.classList.add('combo-native');

    let shown = [];   // items currently listed
    let active = -1;  // highlighted index into `shown`

    const selectedText = () => clean(select.options[select.selectedIndex]?.text ?? '');
    const isOpen = () => !list.hidden;

    function showValue() {
        if (!isOpen()) input.value = selectedText();
        wrap.hidden = select.hidden;
        input.disabled = select.disabled;
    }

    function renderList() {
        shown = filterItems(readItems(select), input.value);
        const selectable = shown.map((item, i) => (item.disabled ? -1 : i)).filter(i => i >= 0);
        if (!selectable.includes(active)) {
            const current = shown.findIndex(item => item.value === select.value && !item.disabled);
            active = input.value && selectable.length ? selectable[0] : (current >= 0 ? current : selectable[0] ?? -1);
        }
        list.replaceChildren();
        let group;
        shown.forEach((item, i) => {
            if (item.group && item.group !== group) {
                const head = document.createElement('div');
                head.className = 'combo-group';
                head.textContent = item.group;
                list.append(head);
            }
            group = item.group;
            const row = document.createElement('div');
            row.className = 'combo-option';
            row.id = `${id}-opt-${i}`;
            row.setAttribute('role', 'option');
            row.textContent = item.text;
            if (item.disabled) row.setAttribute('aria-disabled', 'true');
            if (item.value === select.value) row.setAttribute('aria-selected', 'true');
            if (i === active) row.classList.add('active');
            // mousedown, so the input doesn't lose focus (and close) first.
            row.addEventListener('mousedown', (e) => {
                e.preventDefault();
                if (!item.disabled) choose(item);
            });
            list.append(row);
        });
        if (shown.length === 0) {
            const none = document.createElement('div');
            none.className = 'combo-none';
            none.textContent = 'No matches';
            list.append(none);
        }
        input.setAttribute('aria-activedescendant', active >= 0 ? `${id}-opt-${active}` : '');
        list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    }

    // Keeps the list on screen: wider than a narrow field, but never past the edge.
    function place() {
        list.style.left = '0px';
        const overflow = list.getBoundingClientRect().right - (window.innerWidth - 8);
        if (overflow > 0) list.style.left = `${-overflow}px`;
    }

    function open() {
        if (isOpen() || select.disabled) return;
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        input.placeholder = selectedText();
        input.value = '';
        active = -1;
        renderList();
        place();
    }

    function close() {
        if (!isOpen()) return;
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        input.placeholder = '';
        input.value = selectedText();
    }

    function choose(item) {
        const changed = select.value !== item.value;
        select.value = item.value;
        close();
        if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function move(step) {
        const selectable = shown.map((item, i) => (item.disabled ? -1 : i)).filter(i => i >= 0);
        if (selectable.length === 0) return;
        const at = selectable.indexOf(active);
        active = selectable[(at + step + selectable.length) % selectable.length];
        renderList();
    }

    // Opens on a click, typing or an arrow key; not on focus alone, so focus
    // coming back (e.g. when a popup closes) doesn't pop the list open.
    input.addEventListener('click', open);
    input.addEventListener('blur', close);
    input.addEventListener('input', () => {
        if (!isOpen()) open();
        active = -1;
        renderList();
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!isOpen()) open();
            else move(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (isOpen() && active >= 0) choose(shown[active]);
            else open();
        } else if (e.key === 'Escape' && isOpen()) {
            e.preventDefault();
            e.stopPropagation();  // inside a <dialog>, close the list, not the dialog
            close();
        }
    });

    // Follow the select when its code replaces options or toggles hidden/disabled.
    new MutationObserver(() => {
        if (isOpen()) renderList();
        showValue();
    }).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'disabled'] });

    // ...and when it sets .value, which fires no event.
    const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(select, 'value', {
        configurable: true,
        get() { return valueDesc.get.call(this); },
        set(v) { valueDesc.set.call(this, v); showValue(); },
    });

    showValue();
    return { open, close, input };
}

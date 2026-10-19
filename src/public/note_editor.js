// Shared rich-note editor wiring. Markup lives in note_editor_toolbar.ejs;
// consumers only provide their scoped data-attribute prefix and save callback.
export async function createNoteEditor({ element, toolbar, scope, onSubmit }) {
  if (!element || !toolbar || !scope) return null;
  const selector = (name) => `[data-${scope}-${name}]`;
  const [{ Editor }, { default: StarterKit }, { default: Underline }, { default: Link }, { default: TextAlign }, tableModule, { default: TaskList }, { default: TaskItem }, { default: Superscript }, { default: Subscript }, { default: Highlight }, { default: BaseImage }, mathModule] = await Promise.all([
    import('@tiptap/core'), import('@tiptap/starter-kit'), import('@tiptap/extension-underline'),
    import('@tiptap/extension-link'), import('@tiptap/extension-text-align'), import('@tiptap/extension-table'),
    import('@tiptap/extension-task-list'), import('@tiptap/extension-task-item'), import('@tiptap/extension-superscript'),
    import('@tiptap/extension-subscript'), import('@tiptap/extension-highlight'), import('@tiptap/extension-image'),
    import('https://unpkg.com/@aarkue/tiptap-math-extension@1.4.0/dist/index.js?module').catch(() => null)
  ]);
  const { Table, TableRow, TableHeader, TableCell } = tableModule;
  const MathExtension = mathModule?.default || null;
  const Image = BaseImage.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        style: { default: null, parseHTML: (el) => el.getAttribute('style'), renderHTML: (attrs) => attrs.style ? { style: attrs.style } : {} },
        width: { default: '80%', parseHTML: (el) => el.getAttribute('data-width') || el.style.width || '80%', renderHTML: (attrs) => ({ 'data-width': attrs.width || '80%', style: `width:${attrs.width || '80%'};` }) },
        align: { default: 'center', parseHTML: (el) => el.getAttribute('data-align') || 'center', renderHTML: (attrs) => ({ 'data-align': attrs.align || 'center' }) },
        chemicalKet: { default: null, parseHTML: (el) => el.getAttribute('data-chemical-ket') || null, renderHTML: (attrs) => attrs.chemicalKet ? { 'data-chemical-ket': attrs.chemicalKet } : {} },
        chemicalMolfile: { default: null, parseHTML: (el) => el.getAttribute('data-chemical-molfile') || null, renderHTML: (attrs) => attrs.chemicalMolfile ? { 'data-chemical-molfile': attrs.chemicalMolfile } : {} },
        chemicalSmiles: { default: null, parseHTML: (el) => el.getAttribute('data-chemical-smiles') || null, renderHTML: (attrs) => attrs.chemicalSmiles ? { 'data-chemical-smiles': attrs.chemicalSmiles } : {} }
      };
    }
  });
  const editor = new Editor({
    element,
    editable: true,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: false, underline: false }), Underline,
      Link.configure({ openOnClick: false }), Image.configure({ allowBase64: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }), TaskList, TaskItem.configure({ nested: true }),
      Superscript, Subscript, Highlight.configure({ multicolor: true }), Table.configure({ resizable: true }),
      TableRow, TableHeader, TableCell,
      ...(MathExtension ? [MathExtension.configure({ addInlineMath: true, evaluation: false })] : [])
    ], content: '<p></p>'
  });
  const editorRoot = toolbar.parentElement || toolbar;
  const imageTools = editorRoot.querySelector(selector('image-tools'));
  const tableOps = toolbar.querySelector(selector('table-ops'));
  const positionImageTools = () => {
    if (!imageTools || !editor.isActive('image')) return;
    const image = editor.view.dom.querySelector('img.ProseMirror-selectednode') || editor.view.dom.querySelector('img');
    if (!image) return;
    const rect = image.getBoundingClientRect();
    const width = imageTools.offsetWidth || 320;
    const height = imageTools.offsetHeight || 44;
    imageTools.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    imageTools.style.top = `${Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - height - 8))}px`;
  };
  const syncContextTools = () => {
    imageTools?.classList.toggle('is-visible', editor.isActive('image'));
    tableOps?.classList.toggle('is-visible', editor.isActive('table'));
    if (editor.isActive('image')) requestAnimationFrame(positionImageTools);
  };
  editor.on('selectionUpdate', syncContextTools);
  editor.on('transaction', syncContextTools);
  window.addEventListener('scroll', positionImageTools, { passive: true });
  window.addEventListener('resize', positionImageTools);
  editor.view.dom.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.repeat) {
      event.preventDefault(); event.stopPropagation(); onSubmit?.(Boolean(event.shiftKey));
    }
  }, true);

  const commandTabs = { undo: 'history', redo: 'history', h1: 'text', h2: 'text', h3: 'text', bold: 'text', italic: 'text', underline: 'text', strike: 'text', highlight: 'text', superscript: 'text', subscript: 'text', bullet: 'text', ordered: 'text', checklist: 'text', quote: 'text', code: 'text', 'align-left': 'text', 'align-center': 'text', 'align-right': 'text', 'align-justify': 'text', link: 'insert', image: 'insert', 'chemical-structure': 'insert', hr: 'insert', 'math-inline': 'insert', 'math-block': 'insert' };
  const tabs = toolbar.querySelectorAll(selector('toolbar-tab-button'));
  const controls = Array.from(toolbar.children).filter((node) => !node.classList.contains('notes-toolbar-tabs'));
  controls.forEach((control) => {
    const cmd = control.getAttribute(`data-${scope}-cmd`);
    if (cmd && commandTabs[cmd]) control.dataset.notesToolbarTab = commandTabs[cmd];
    else if (control.matches(selector('image-tools'))) control.dataset.notesToolbarTab = 'insert';
    else if (control.classList.contains('table-tools')) control.dataset.notesToolbarTab = 'table';
  });
  let tab = 'text';
  [...controls].reverse().forEach((control) => { if (control.dataset.notesToolbarTab) tab = control.dataset.notesToolbarTab; else if (control.classList.contains('toolbar-sep')) control.dataset.notesToolbarTab = tab; });
  const showTab = (next) => {
    controls.forEach((control) => { control.hidden = !['history', next].includes(control.dataset.notesToolbarTab || 'none'); });
    tabs.forEach((button) => { const selected = button.getAttribute(`data-${scope}-toolbar-tab-button`) === next; button.classList.toggle('is-active', selected); button.setAttribute('aria-selected', String(selected)); });
  };
  tabs.forEach((button) => button.addEventListener('click', () => showTab(button.getAttribute(`data-${scope}-toolbar-tab-button`) || 'text')));
  showTab('text');

  const run = (command, options = {}) => {
    const chain = editor.chain().focus();
    const action = {
      h1: () => chain.toggleHeading({ level: 1 }).run(), h2: () => chain.toggleHeading({ level: 2 }).run(), h3: () => chain.toggleHeading({ level: 3 }).run(),
      bold: () => chain.toggleBold().run(), italic: () => chain.toggleItalic().run(), underline: () => chain.toggleUnderline().run(), strike: () => chain.toggleStrike().run(), highlight: () => chain.toggleHighlight().run(), superscript: () => chain.toggleSuperscript().run(), subscript: () => chain.toggleSubscript().run(),
      bullet: () => chain.toggleBulletList().run(), ordered: () => chain.toggleOrderedList().run(), checklist: () => chain.toggleTaskList().run(), quote: () => chain.toggleBlockquote().run(), code: () => chain.toggleCodeBlock().run(), hr: () => chain.setHorizontalRule().run(), undo: () => chain.undo().run(), redo: () => chain.redo().run(),
      'align-left': () => chain.setTextAlign('left').run(), 'align-center': () => chain.setTextAlign('center').run(), 'align-right': () => chain.setTextAlign('right').run(), 'align-justify': () => chain.setTextAlign('justify').run(),
      table: () => chain.insertTable({ rows: Number(options.rows) || 3, cols: Number(options.cols) || 3, withHeaderRow: true }).run(), 'table-row-add': () => chain.addRowAfter().run(), 'table-row-del': () => chain.deleteRow().run(), 'table-col-add': () => chain.addColumnAfter().run(), 'table-col-del': () => chain.deleteColumn().run(), 'table-del': () => chain.deleteTable().run(),
      'image-width-25': () => chain.updateAttributes('image', { style: 'width:25%;' }).run(), 'image-width-50': () => chain.updateAttributes('image', { style: 'width:50%;' }).run(), 'image-width-75': () => chain.updateAttributes('image', { style: 'width:75%;' }).run(), 'image-width-100': () => chain.updateAttributes('image', { style: 'width:100%;' }).run(), 'image-align-left': () => chain.updateAttributes('image', { style: 'display:block;margin:0 auto 0 0;' }).run(), 'image-align-center': () => chain.updateAttributes('image', { style: 'display:block;margin:0 auto;' }).run(), 'image-align-right': () => chain.updateAttributes('image', { style: 'display:block;margin:0 0 0 auto;' }).run(), 'image-delete': () => editor.isActive('image') && chain.deleteSelection().run()
    }[command];
    if (action) return action();
    if (command === 'link') { const href = window.prompt('Link URL', editor.getAttributes('link').href || ''); if (href === null) return; return href.trim() ? chain.extendMarkRange('link').setLink({ href: href.trim() }).run() : chain.extendMarkRange('link').unsetLink().run(); }
    if (command === 'image') { const src = window.prompt('Image URL'); return src && chain.setImage({ src: src.trim() }).run(); }
    if (command === 'chemical-structure') {
      const chemicalEditor = window.ChemicalStructureEditor;
      if (!chemicalEditor) { window.alert('Chemical editor is still loading. Please try again in a moment.'); return; }
      chemicalEditor.open().then((structure) => {
        if (!structure) return;
        editor.chain().focus().setImage({ src: structure.pngDataUrl, alt: 'Chemical structure', title: null, width: '80%', align: 'center', chemicalKet: structure.ket, chemicalMolfile: structure.molfile, chemicalSmiles: structure.smiles }).run();
      }).catch((error) => window.alert(error instanceof Error ? error.message : 'Unable to export chemical structure.'));
      return;
    }
    if (command === 'math-inline' || command === 'math-block') { const latex = window.prompt(command === 'math-inline' ? 'Formula (inline)' : 'Formula (block)', command === 'math-inline' ? 'x^2' : '\\sum_{i=1}^{n} x_i'); if (!latex) return; return chain.insertContent({ type: 'inlineMath', attrs: { latex: latex.trim(), evaluate: 'no', display: command === 'math-block' ? 'yes' : 'no' } }).run(); }
  };
  editorRoot.querySelectorAll(selector('cmd')).forEach((button) => button.addEventListener('click', () => run(button.getAttribute(`data-${scope}-cmd`) || '')));

  const picker = toolbar.querySelector(selector('table-picker'));
  const pickerToggle = toolbar.querySelector(selector('table-picker-toggle'));
  const pickerGrid = toolbar.querySelector(selector('table-picker-grid'));
  const pickerLabel = toolbar.querySelector(selector('table-picker-label'));
  let rows = 3; let cols = 3;
  const paint = () => { pickerGrid?.querySelectorAll('.table-picker-cell').forEach((cell) => cell.classList.toggle('active', Number(cell.dataset.row) <= rows && Number(cell.dataset.col) <= cols)); if (pickerLabel) pickerLabel.textContent = `${rows} x ${cols}`; };
  if (pickerGrid && !pickerGrid.childElementCount) for (let row = 1; row <= 10; row += 1) for (let col = 1; col <= 10; col += 1) { const cell = document.createElement('button'); cell.type = 'button'; cell.className = 'table-picker-cell'; cell.dataset.row = String(row); cell.dataset.col = String(col); cell.setAttribute('aria-label', `Insert ${row} by ${col} table`); cell.addEventListener('mouseenter', () => { rows = row; cols = col; paint(); }); cell.addEventListener('click', () => { run('table', { rows: row, cols: col }); picker.hidden = true; }); pickerGrid.appendChild(cell); }
  paint();
  pickerToggle?.addEventListener('click', (event) => { event.stopPropagation(); const opening = picker.hidden; picker.hidden = !opening; if (opening) { const rect = pickerToggle.getBoundingClientRect(); picker.style.position = 'fixed'; picker.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - (picker.offsetWidth || 224) - 8))}px`; picker.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - (picker.offsetHeight || 224) - 8))}px`; picker.style.zIndex = '1200'; } });
  picker?.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', () => { if (picker) picker.hidden = true; });
  return editor;
}

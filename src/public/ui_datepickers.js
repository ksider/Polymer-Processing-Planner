(() => {
  const selector = '[data-ui-datepicker]';

  const movePickerIntoDialog = (field) => {
    const dialog = field.closest('dialog');
    const datepicker = field.datepicker;
    const picker = datepicker?.picker?.element;
    if (!dialog || !datepicker || !picker || datepicker.config.container === dialog) return;

    // A native <dialog> is rendered in the browser's top layer. Flowbite
    // appends pickers to <body> by default, which would put this pop-up under
    // the dialog. Keep the picker in the same top layer as its input.
    datepicker.config.container = dialog;
    dialog.appendChild(picker);
  };

  const bridgeChangeDate = (field) => {
    if (field.dataset.datepickerChangeBridge === 'true') return;
    field.dataset.datepickerChangeBridge = 'true';
    // flowbite-datepicker emits `changeDate`, while existing forms save on the
    // native `change` event. Bridge the two so selecting a day saves exactly
    // like editing a regular field.
    field.addEventListener('changeDate', () => {
      field.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  const getFields = (root = document) => {
    if (root.nodeType === Node.ELEMENT_NODE && root.matches?.(selector)) return [root];
    return Array.from(root.querySelectorAll?.(selector) || []);
  };

  const initialize = (root = document) => {
    const fields = getFields(root);
    if (fields.length === 0) return;

    fields.forEach((field) => {
      // The Flowbite datepicker owns a text input. Converting opted-in native
      // date fields here keeps old markup/data bindings intact while avoiding
      // two competing calendars in the same control.
      if (field.type === 'date') field.type = 'text';
      field.autocomplete = 'off';
      bridgeChangeDate(field);

      if (field.datepicker) {
        movePickerIntoDialog(field);
        field.dataset.datepickerReady = 'true';
        return;
      }

      if (typeof window.Datepicker !== 'function') {
        field.dataset.datepickerReady = 'false';
        console.error('Flowbite Datepicker did not load for', field.id);
        return;
      }

      try {
        new window.Datepicker(field, {
          autohide: field.hasAttribute('datepicker-autohide'),
          format: field.getAttribute('datepicker-format') || 'yyyy-mm-dd',
        }, {
          id: field.id,
          override: true,
        });
        movePickerIntoDialog(field);
        field.dataset.datepickerReady = field.datepicker ? 'true' : 'false';
      } catch (error) {
        field.dataset.datepickerReady = 'false';
        console.error('Unable to initialize Flowbite Datepicker for', field.id, error);
      }
    });
  };

  window.initExperimentDatepickers = initialize;

  const start = () => {
    initialize();
    new MutationObserver((mutations) => {
      mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) initialize(node);
      }));
    }).observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();

(() => {
  // The UI-kit owns every user-facing date field. Older templates do not need
  // to remember a per-input marker, which prevents native and Flowbite
  // calendars from appearing side by side on different process pages.
  const selector = 'input[type="date"], [data-ui-datepicker]';

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

  const hideDialogPickers = (dialog) => {
    dialog.querySelectorAll(selector).forEach((field) => field.datepicker?.hide?.());
  };

  const normalizeHiddenPickerState = (field) => {
    if (field.dataset.datepickerHiddenStateBound === 'true') return;
    field.dataset.datepickerHiddenStateBound = 'true';
    field.addEventListener('hide', () => {
      const picker = field.datepicker?.picker?.element;
      if (!picker) return;
      // flowbite-datepicker 2.0.0 leaves `active block hidden` together in
      // Picker.hide(). The bundled stylesheet has `.datepicker.active` with
      // higher specificity than `.hidden`, so that contradictory state remains
      // visible. Keep Flowbite's state transition but remove its stale visible
      // classes after the documented `hide` event.
      picker.classList.remove('active', 'block');
      picker.classList.add('hidden');
    });
  };

  const bindDialogDismissal = (field) => {
    const dialog = field.closest('dialog');
    if (!dialog || dialog.dataset.datepickerDismissBound === 'true') return;
    dialog.dataset.datepickerDismissBound = 'true';
    // Datepickers are moved into the dialog so they share its top layer.
    // Hiding the dialog alone does not dismiss that detached pop-up.
    dialog.addEventListener('close', () => hideDialogPickers(dialog));
    dialog.addEventListener('cancel', () => hideDialogPickers(dialog));

    const hideWhenFocusLeavesPicker = (event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;

      dialog.querySelectorAll(selector).forEach((input) => {
        const datepicker = input.datepicker;
        const picker = datepicker?.picker?.element;
        if (!datepicker?.picker?.active) return;
        // Keep the calendar open while the user works with its own input or
        // popup. Any other control in this dialog closes it through Flowbite's
        // public API.
        if (input.contains(target) || picker?.contains(target)) return;
        datepicker.hide();
      });
    };

    // Flowbite's default outside-click handler depends on the input remaining
    // document.activeElement. That is unreliable once the picker is moved into
    // a native dialog's top layer, so observe the dialog's real interaction
    // boundary instead. Capture makes the close happen before another control
    // receives focus.
    dialog.addEventListener('mousedown', hideWhenFocusLeavesPicker, true);
    dialog.addEventListener('focusin', hideWhenFocusLeavesPicker, true);
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
      // The Flowbite datepicker owns a text input. Keep existing form values
      // and handlers intact while replacing every native date control.
      const wasNativeDateInput = field.type === 'date';
      if (wasNativeDateInput) {
        field.setAttribute('data-ui-datepicker', '');
        field.type = 'text';
      }
      field.autocomplete = 'off';
      bridgeChangeDate(field);
      normalizeHiddenPickerState(field);
      bindDialogDismissal(field);

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
          autohide: wasNativeDateInput || field.hasAttribute('datepicker-autohide'),
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

  window.initUiDatepickers = initialize;
  // Kept for templates from the first incremental migration.
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

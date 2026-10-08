(() => {
  const fieldClasses = [
    '!block', '!w-full', '!rounded-base', '!border', '!border-default-medium', '!bg-neutral-secondary-medium',
    '!px-3', '!py-2.5', '!text-sm', '!text-heading', '!shadow-xs', 'placeholder:!text-body',
    'focus:!border-brand', 'focus:!ring-brand',
    'disabled:!cursor-not-allowed', 'disabled:!bg-neutral-tertiary', 'disabled:!text-fg-disabled'
  ];
  const compactFieldClasses = [
    '!w-full', '!min-w-20', '!rounded-base', '!border', '!border-default-medium', '!bg-neutral-secondary-medium',
    '!px-2.5', '!py-2', '!text-sm', '!text-heading', 'placeholder:!text-body',
    'focus:!border-brand', 'focus:!ring-brand',
    'disabled:!cursor-not-allowed', 'disabled:!bg-neutral-tertiary', 'disabled:!text-fg-disabled'
  ];
  const checkboxClasses = [
    '!w-4', '!h-4', '!border', '!border-default-medium', '!rounded-xs', '!bg-neutral-secondary-medium',
    'focus:!ring-2', 'focus:!ring-brand-soft', 'disabled:!cursor-not-allowed', 'disabled:!opacity-50'
  ];
  const radioClasses = [
    '!w-4', '!h-4', '!border', '!border-default-medium', '!bg-neutral-secondary-medium',
    'focus:!ring-2', 'focus:!ring-brand-soft', 'disabled:!cursor-not-allowed', 'disabled:!opacity-50'
  ];
  const labelClasses = ['!mb-2.5', '!block', '!text-sm', '!font-medium', '!text-heading'];

  // `data-ui-control-exempt` belongs to a particular control, not its form.
  // A form can contain ordinary controls that still need the UI-kit styling.
  const isExcluded = (element) => Boolean(
    element.matches?.('[data-ui-control-exempt]')
    || element.closest('.notes-drawer, .tiptap, [contenteditable]')
  );

  const applyControl = (control) => {
    if (isExcluded(control) || control.type === 'hidden') return;
    const isCompact = Boolean(control.closest('td, th'));
    if (control.type === 'checkbox') {
      control.classList.add(...checkboxClasses);
      return;
    }
    if (control.type === 'radio') {
      control.classList.add(...radioClasses);
      return;
    }
    control.classList.add(...(isCompact ? compactFieldClasses : fieldClasses));
  };

  const applyLabels = (root) => {
    root.querySelectorAll('label').forEach((label) => {
      if (isExcluded(label) || label.querySelector('input[type="checkbox"], input[type="radio"]')) return;
      label.classList.add(...labelClasses);
    });
  };

  const apply = (root = document) => {
    if (root.nodeType === Node.ELEMENT_NODE && root.matches?.('input, select, textarea')) applyControl(root);
    root.querySelectorAll?.('input, select, textarea').forEach(applyControl);
    if (root.nodeType === Node.ELEMENT_NODE && root.matches?.('label')) applyLabels(root.parentElement || root);
    applyLabels(root);
  };

  const start = () => {
    apply();
    new MutationObserver((mutations) => {
      mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) apply(node);
      }));
    }).observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();

(() => {
  const toolbarButtons = [
    ['.fc-prev-button', 'Previous period', '<svg class="w-4 h-4" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 14 10"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 5H1m0 0 4 4M1 5l4-4"/></svg>'],
    ['.fc-next-button', 'Next period', '<svg class="w-4 h-4" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 14 10"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M1 5h12m0 0L9 1m4 4L9 9"/></svg>']
  ];

  const eventIcons = {
    task: 'task_alt',
    run: 'science',
    qual_run: 'biotech'
  };

  const setToolbarIcons = (host) => {
    toolbarButtons.forEach(([selector, label, icon]) => {
      const button = host.querySelector(selector);
      if (!button) return;
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
      button.innerHTML = icon;
    });
  };

  const eventContent = (info) => {
    const content = document.createElement('span');
    content.className = 'calendar-event-content';
    const icon = document.createElement('span');
    icon.className = 'material-symbols-rounded calendar-event-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = eventIcons[info.event.extendedProps.kind] || 'event';
    const label = document.createElement('span');
    label.className = 'calendar-event-label';
    label.textContent = info.event.title;
    content.append(icon, label);
    return { domNodes: [content] };
  };

  const notifyUnavailable = (message) => window.IMPlanner?.notify?.({ type: 'error', title: 'Calendar unavailable', message });

  const create = ({ host, loadEvents, onEventClick, initialView } = {}) => {
    if (!host || !window.FullCalendar) {
      notifyUnavailable('The calendar library could not be loaded.');
      return null;
    }

    const calendar = new window.FullCalendar.Calendar(host, {
      initialView: initialView || (window.innerWidth < 640 ? 'listMonth' : 'dayGridMonth'),
      height: 'auto',
      firstDay: 1,
      headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,listMonth' },
      events: async (fetchInfo, successCallback, failureCallback) => {
        try {
          const events = await loadEvents?.(fetchInfo);
          if (!Array.isArray(events)) throw new Error('Calendar response has an invalid event list');
          successCallback(events);
        } catch (error) {
          failureCallback(error);
          notifyUnavailable('Events could not be loaded.');
        }
      },
      datesSet: () => window.requestAnimationFrame(() => setToolbarIcons(host)),
      eventContent,
      eventClick: (info) => {
        info.jsEvent.preventDefault();
        if (onEventClick) return onEventClick(info);
        if (info.event.url) window.location.assign(info.event.url);
      }
    });

    return {
      render() {
        calendar.render();
        setToolbarIcons(host);
      },
      refetchEvents: () => calendar.refetchEvents(),
      updateSize: () => calendar.updateSize(),
      destroy: () => calendar.destroy()
    };
  };

  window.IMPlannerWorkspaceCalendar = { create, decorate: setToolbarIcons, eventContent };
})();

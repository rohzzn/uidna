(function () {
  // Fixture B for UI DNA. Deterministic: no clock, no randomness, no timer that outlives the action that started it.
  var SEARCH_DEBOUNCE_MS = 200;

  var rows = document.getElementById('orders-body');
  var count = document.getElementById('orders-count');
  var empty = document.getElementById('orders-empty');
  var toast = document.getElementById('toast');
  var search = document.getElementById('order-search');
  var chips = Array.prototype.slice.call(document.querySelectorAll('.chip'));
  var sortButtons = Array.prototype.slice.call(document.querySelectorAll('.sort'));
  var toggle = document.querySelector('.sidebar-toggle');
  var sidebar = document.getElementById('sidebar');

  var orders = [];
  var state = { query: '', status: 'all', field: 'id', direction: 'ascending' };

  function formatAmount(value) {
    var parts = value.toFixed(2).split('.');
    return '$' + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + parts[1];
  }

  function matches(order) {
    if (state.status !== 'all' && order.status !== state.status) return false;
    return state.query === '' || (order.id + ' ' + order.customer).toLowerCase().indexOf(state.query) !== -1;
  }

  function compare(a, b) {
    var x = a[state.field];
    var y = b[state.field];
    var order = typeof x === 'number' ? x - y : x < y ? -1 : x > y ? 1 : 0;
    return state.direction === 'ascending' ? order : -order;
  }

  function cell(className, text) {
    var td = document.createElement('td');
    td.className = className;
    td.textContent = text;
    return td;
  }

  function renderRow(order) {
    var row = document.createElement('tr');
    var key = document.createElement('th');
    key.scope = 'row';
    key.className = 'col-id';
    key.textContent = order.id;
    row.appendChild(key);
    row.appendChild(cell('col-customer', order.customer));
    var status = cell('col-status', '');
    var badge = document.createElement('span');
    badge.className = 'badge badge-' + order.status.toLowerCase();
    badge.textContent = order.status;
    status.appendChild(badge);
    row.appendChild(status);
    row.appendChild(cell('col-amount', formatAmount(order.amount)));
    row.appendChild(cell('col-date', order.date));
    var actions = cell('col-actions', '');
    var archive = document.createElement('button');
    archive.type = 'button';
    archive.className = 'row-action';
    archive.setAttribute('aria-label', 'Archive ' + order.id);
    archive.textContent = 'Archive';
    archive.addEventListener('click', function () { archiveOrder(order.id); });
    actions.appendChild(archive);
    row.appendChild(actions);
    return row;
  }

  function render() {
    var visible = orders.filter(matches).sort(compare);
    rows.innerHTML = '';
    visible.forEach(function (order) { rows.appendChild(renderRow(order)); });
    count.textContent = 'Showing ' + visible.length + ' of ' + orders.length + ' orders';
    empty.hidden = visible.length > 0;
  }

  function syncChips() {
    chips.forEach(function (chip) {
      chip.setAttribute('aria-pressed', chip.getAttribute('data-status') === state.status ? 'true' : 'false');
    });
  }

  function syncSortHeaders() {
    sortButtons.forEach(function (button) {
      var header = button.parentElement;
      if (button.getAttribute('data-field') === state.field) header.setAttribute('aria-sort', state.direction);
      else header.removeAttribute('aria-sort');
    });
  }

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
  }

  // A side effect: UI DNA must block it (the toast then says it failed) and never repeat it on another row.
  function archiveOrder(id) {
    fetch('/api/orders/' + encodeURIComponent(id) + '/archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function () {
        orders = orders.filter(function (order) { return order.id !== id; });
        render();
        showToast(id + ' archived.');
      })
      .catch(function () { showToast('Could not archive ' + id + '.'); });
  }

  var searchTimer = null;
  search.addEventListener('input', function () {
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      searchTimer = null;
      state.query = search.value.trim().toLowerCase();
      render();
    }, SEARCH_DEBOUNCE_MS);
  });

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      var value = chip.getAttribute('data-status');
      // Pressing the active status chip again shows every status ("All" stays pressed).
      state.status = state.status === value ? 'all' : value;
      syncChips();
      render();
    });
  });

  sortButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      var field = button.getAttribute('data-field');
      if (state.field === field) {
        state.direction = state.direction === 'ascending' ? 'descending' : 'ascending';
      } else {
        state.field = field;
        state.direction = 'ascending';
      }
      syncSortHeaders();
      render();
    });
  });

  function setExpanded(open) {
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    if (open) sidebar.classList.add('is-expanded');
    else sidebar.classList.remove('is-expanded');
  }

  toggle.addEventListener('click', function () {
    setExpanded(toggle.getAttribute('aria-expanded') !== 'true');
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      setExpanded(false);
      toggle.focus();
    }
  });

  fetch('/api/orders.json')
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .then(function (data) {
      orders = data.orders;
      render();
    })
    .catch(function () { count.textContent = 'Could not load orders.'; });
})();

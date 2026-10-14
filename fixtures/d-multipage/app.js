(function () {
  // Tabs (features page)
  var tablist = document.querySelector('[role="tablist"]');
  if (tablist) {
    var tabs = Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));
    function select(tab) {
      tabs.forEach(function (t) {
        var selected = t === tab;
        t.setAttribute('aria-selected', selected ? 'true' : 'false');
        t.tabIndex = selected ? 0 : -1;
        var panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !selected;
      });
      tab.focus();
    }
    tabs.forEach(function (tab, index) {
      tab.addEventListener('click', function () { select(tab); });
      tab.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowRight') select(tabs[(index + 1) % tabs.length]);
        if (event.key === 'ArrowLeft') select(tabs[(index - 1 + tabs.length) % tabs.length]);
      });
    });
  }

  // Billing toggle (pricing page)
  var billing = document.getElementById('billing');
  if (billing) {
    billing.addEventListener('click', function () {
      var yearly = billing.getAttribute('aria-pressed') !== 'true';
      billing.setAttribute('aria-pressed', yearly ? 'true' : 'false');
      billing.textContent = yearly ? 'Monthly billing' : 'Yearly billing (save 20%)';
      Array.prototype.forEach.call(document.querySelectorAll('.amount'), function (amount) {
        amount.textContent = yearly ? amount.getAttribute('data-yearly') : amount.getAttribute('data-monthly');
      });
    });
  }
})();

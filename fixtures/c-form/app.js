(function () {
  var form = document.getElementById('signup');
  var status = document.getElementById('status');
  var notes = document.getElementById('notes');

  var messages = {
    name: 'Enter your full name.',
    email: 'Enter a valid email address.',
    password: 'Use at least 8 characters.',
    terms: 'You must agree to the terms.'
  };

  function setError(input, message) {
    var error = document.getElementById(input.id + '-error');
    if (message) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-errormessage', error.id);
      error.textContent = message;
      error.hidden = false;
    } else {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-errormessage');
      error.textContent = '';
      error.hidden = true;
    }
  }

  function validate() {
    var valid = true;
    ['name', 'email', 'password', 'terms'].forEach(function (id) {
      var input = document.getElementById(id);
      var ok = input.checkValidity();
      setError(input, ok ? '' : messages[id]);
      if (!ok) valid = false;
    });
    return valid;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    status.hidden = true;
    if (!validate()) {
      var first = form.querySelector('[aria-invalid="true"]');
      if (first) first.focus();
      return;
    }
    var payload = { name: form.name.value, email: form.email.value, plan: form.plan.value };
    fetch('/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        status.textContent = data.ok ? 'Welcome, ' + payload.name + '. Check your inbox.' : 'Something went wrong.';
        status.hidden = false;
      })
      .catch(function () {
        status.textContent = 'Could not reach the server.';
        status.hidden = false;
      });
  });

  ['name', 'email', 'password', 'terms'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', function (event) {
      if (event.target.getAttribute('aria-invalid') === 'true' && event.target.checkValidity()) setError(event.target, '');
    });
  });

  document.getElementById('fill-example').addEventListener('click', function () {
    form.name.value = 'Ada Lovelace';
    form.email.value = 'ada@example.com';
    form.password.value = 'analytical-engine';
    form.terms.checked = true;
    validate();
  });

  function renderNotes(items) {
    notes.innerHTML = '';
    items.forEach(function (item) {
      var li = document.createElement('li');
      li.className = 'note';
      var title = document.createElement('p');
      title.className = 'note-title';
      title.textContent = item.title;
      var meta = document.createElement('p');
      meta.className = 'note-meta';
      meta.textContent = item.updated + ' · ' + item.links + ' links';
      li.appendChild(title);
      li.appendChild(meta);
      notes.appendChild(li);
    });
  }

  function loadNotes() {
    fetch('/api/items.json')
      .then(function (response) { return response.json(); })
      .then(function (data) { renderNotes(data.items); })
      .catch(function () { renderNotes([]); });
  }

  document.getElementById('reload-notes').addEventListener('click', loadNotes);
  loadNotes();
})();

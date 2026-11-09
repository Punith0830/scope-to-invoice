const byId = id => document.getElementById(id);
const compare = byId('compare');
const confirm = byId('confirm');
const agreement = byId('agreement');
const notes = byId('notes');
const checkStatus = byId('check-status');
const sample = [agreement.value, notes.value];
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', currencyDisplay: 'code' });
let comparisonId;
let reviewed = [];
let outcome;

async function call(path, method = 'GET', body) {
  const response = await fetch('/api/' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error ?? 'The app could not complete this request.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function show(screen) {
  for (const name of ['records', 'review', 'outcome']) {
    byId(name).hidden = name !== screen;
    if (name === screen) byId('step-' + name).setAttribute('aria-current', 'step');
    else byId('step-' + name).removeAttribute('aria-current');
  }
  byId(screen + '-title').focus();
}

const format = amount => usd.format(amount / 100);

function matchesEvidence({ charge, amount }) {
  return charge.amount !== null && amount.validity.valid
    && Math.abs(amount.valueAsNumber * 100 - charge.amount) < 0.00001;
}

function selected() {
  return reviewed.filter(item => item.include.checked && matchesEvidence(item));
}

function summarize() {
  const items = selected();
  const total = items.reduce((sum, item) => sum + item.charge.amount, 0);
  byId('selection').textContent = items.length
    ? items.length + ' selected · ' + format(total)
    : 'No supported charges selected';
  confirm.disabled = !items.length;
}

function renderCharge(charge) {
  const card = byId('charge-template').content.firstElementChild.cloneNode(true);
  const find = selector => card.querySelector(selector);
  const heading = find('h3');
  const eligibility = find('.eligibility');
  const include = find('.include');
  const amount = find('.amount');
  heading.textContent = charge.name;
  heading.id = 'charge-' + charge.id;
  card.setAttribute('aria-labelledby', heading.id);
  find('.agreement-evidence').textContent = charge.agreementLine || 'No matching agreement text.';
  find('.work-evidence').textContent = charge.workQuote || 'No matching work note.';
  const supported = charge.amount !== null;
  card.classList.toggle('review-needed', !supported);
  find('.charge-controls').hidden = !supported;
  eligibility.id = 'eligibility-' + charge.id;
  amount.id = 'amount-' + charge.id;
  find('.amount-label').htmlFor = amount.id;
  amount.setAttribute('aria-describedby', eligibility.id);
  include.setAttribute('aria-label', 'Include ' + charge.name);
  if (!supported) {
    eligibility.textContent = 'Needs review · Excluded. ' + (charge.reason || 'The available evidence is incomplete.');
  } else {
    eligibility.textContent = 'Supported by the supplied records.';
    eligibility.setAttribute('role', 'status');
    amount.value = (charge.amount / 100).toFixed(2);
    include.checked = true;
    amount.addEventListener('input', () => {
      const matches = matchesEvidence({ charge, amount });
      if (!matches) include.checked = false;
      include.disabled = !matches;
      card.classList.toggle('review-needed', !matches);
      eligibility.textContent = matches
        ? 'Supported by the supplied records.'
        : 'Needs review · Excluded. The agreement supports ' + format(charge.amount) + '.';
      summarize();
    });
    include.addEventListener('change', summarize);
  }
  byId('charges').append(card);
  return { charge, include, amount };
}

function renderOutcome(attempt, moveFocus = true) {
  outcome = attempt;
  const states = {
    pending: ['Draft request in progress', 'Waiting for PayPal sandbox to respond.'],
    rejected: ['Draft creation rejected', 'PayPal sandbox rejected the request. Review the sandbox configuration.'],
    unconfirmed: ['Draft creation unconfirmed', 'A draft may exist. Check PayPal sandbox for the invoice reference before making another attempt.'],
    incomplete: ['Verification incomplete', 'PayPal returned a draft ID. The retrieved status, items, or total have not been verified.'],
    verified: ['Sandbox draft verified', 'PayPal returned a DRAFT with the confirmed items and total.'],
  };
  const [title, message] = states[attempt.status];
  byId('outcome-title').textContent = title;
  byId('outcome-message').textContent = message;
  byId('outcome-reference').textContent = attempt.reference ? 'Invoice reference · ' + attempt.reference : '';
  byId('outcome-id').textContent = attempt.id ? 'PayPal sandbox draft ID · ' + attempt.id : '';
  byId('confirmed-items').replaceChildren(...attempt.items.map(item => {
    const li = document.createElement('li');
    li.textContent = item.name + ' · ' + format(item.amount);
    return li;
  }));
  byId('confirmed-total').textContent = 'Total · ' + format(attempt.total);
  checkStatus.hidden = !['pending', 'unconfirmed', 'incomplete'].includes(attempt.status);
  checkStatus.textContent = attempt.status === 'incomplete' ? 'Verify existing draft' : 'Refresh status';
  if (moveFocus) show('outcome');
}

byId('compare-form').addEventListener('submit', async event => {
  event.preventDefault();
  compare.disabled = true;
  agreement.readOnly = true;
  notes.readOnly = true;
  byId('restore').disabled = true;
  byId('record-status').textContent = 'Comparing the records…';
  try {
    const data = await call('compare', 'POST', { agreement: agreement.value, notes: notes.value });
    comparisonId = data.id;
    byId('charges').replaceChildren();
    reviewed = data.charges.map(renderCharge);
    byId('review-status').textContent = data.charges.length ? '' : 'The analysis found no completed charges to review.';
    byId('record-status').textContent = '';
    summarize();
    show('review');
  } catch (error) {
    byId('record-status').textContent = error.status ? error.message : 'The comparison service could not be reached.';
  } finally {
    compare.disabled = false;
    agreement.readOnly = false;
    notes.readOnly = false;
    byId('restore').disabled = false;
  }
});

byId('restore').addEventListener('click', () => {
  [agreement.value, notes.value] = sample;
  byId('record-status').textContent = 'Sample records restored.';
  agreement.focus();
});
byId('edit-records').addEventListener('click', () => show('records'));

confirm.addEventListener('click', async () => {
  const items = selected().map(({ charge }) => charge);
  if (!items.length) return;
  confirm.disabled = true;
  const snapshot = { items, total: items.reduce((sum, item) => sum + item.amount, 0) };
  renderOutcome({ ...snapshot, status: 'pending' });
  checkStatus.hidden = true;
  try {
    renderOutcome(await call('draft', 'POST', { comparisonId, selectedIds: items.map(item => item.id) }));
  } catch (error) {
    if ([400, 409, 415, 502, 503].includes(error.status)) {
      byId('review-status').textContent = error.message;
      summarize();
      show('review');
    } else {
      renderOutcome({ ...snapshot, status: 'unconfirmed' });
    }
  }
});

checkStatus.addEventListener('click', async () => {
  checkStatus.disabled = true;
  try {
    const attempt = outcome.status === 'incomplete' ? await call('draft/verify', 'POST') : await call('draft');
    if (attempt) renderOutcome(attempt);
    else byId('outcome-message').textContent = 'The server has no recorded draft attempt. Reload to start a new comparison.';
  } catch {
    byId('outcome-message').textContent = 'Status could not be refreshed. The previous outcome still applies.';
  } finally {
    checkStatus.disabled = false;
  }
});

try {
  const attempt = await call('draft');
  if (attempt) renderOutcome(attempt);
  else compare.disabled = false;
} catch {
  byId('record-status').textContent = 'The app could not check the draft state. Reload when the local server is running.';
}

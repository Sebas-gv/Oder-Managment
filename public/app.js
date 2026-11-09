'use strict';

const COLUMNS = [
  { status: 'placed', label: 'Placed' },
  { status: 'accepted', label: 'Accepted' },
  { status: 'assigned', label: 'Assigned' },
  { status: 'picked_up', label: 'Picked up' },
  { status: 'delivered', label: 'Delivered' },
];
const NEXT = { placed: 'accepted', accepted: 'assigned', assigned: 'picked_up', picked_up: 'delivered' };
const ACTION_LABEL = {
  accepted: 'Accept',
  assigned: 'Assign driver',
  picked_up: 'Mark picked up',
  delivered: 'Mark delivered',
};

const state = { orders: [], drivers: [], selectedDriver: {} }; // selectedDriver[orderId] = driverId

// Builds elements with textContent (never innerHTML) to avoid XSS from user data.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 3500);
}

const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

async function refresh() {
  [state.orders, state.drivers] = await Promise.all([api('GET', '/api/orders'), api('GET', '/api/drivers')]);
  render();
}

async function advance(order) {
  const to = NEXT[order.status];
  const body = { status: to };
  if (to === 'assigned') {
    body.driverId = state.selectedDriver[order.id];
    if (!body.driverId) return toast('Pick a driver first', true);
  }
  try {
    await api('POST', `/api/orders/${order.id}/status`, body);
    delete state.selectedDriver[order.id];
    toast(`Order ${order.id} → ${to}`);
  } catch (err) {
    toast(err.message, true);
  }
  await refresh();
}

function renderOrder(order, color) {
  const next = NEXT[order.status];
  const driver = state.drivers.find((d) => d.id === order.driverId);
  const actions = [];

  if (next === 'assigned') {
    const free = state.drivers.filter((d) => !d.busy);
    actions.push(
      h(
        'select',
        {
          'aria-label': `Driver for ${order.id}`,
          onchange: (e) => (state.selectedDriver[order.id] = e.target.value),
        },
        h('option', { value: '' }, free.length ? 'Choose driver…' : 'No free drivers'),
        free.map((d) =>
          h('option', { value: d.id, selected: state.selectedDriver[order.id] === d.id }, d.name)
        )
      )
    );
  }
  if (next) {
    actions.push(h('button', { class: 'go', onclick: () => advance(order) }, ACTION_LABEL[next]));
  }

  return h(
    'article',
    { class: 'order', style: `--col: var(--${color})` },
    h('span', { class: 'id' }, order.id),
    h('span', { class: 'name' }, order.customerName),
    h('span', { class: 'addr' }, order.address),
    h('ul', {}, order.items.map((it) => h('li', {}, `${it.quantity} × ${it.name}`))),
    h('span', { class: 'meta' }, `Total ${money(order.total)}`),
    driver && h('span', { class: 'meta' }, `Driver: ${driver.name}`),
    actions.length ? h('div', { class: 'actions' }, actions) : null
  );
}

function render() {
  const board = document.getElementById('board');
  board.replaceChildren(
    ...COLUMNS.map(({ status, label }) => {
      const orders = state.orders.filter((o) => o.status === status);
      return h(
        'section',
        { class: 'column', style: `--col: var(--${status})` },
        h('h3', {}, h('span', {}, label), h('span', { class: 'count' }, orders.length)),
        orders.length ? orders.map((o) => renderOrder(o, status)) : h('div', { class: 'empty' }, 'No orders')
      );
    })
  );

  document.getElementById('drivers').replaceChildren(
    ...state.drivers.map((d) =>
      h(
        'li',
        {},
        h('span', {}, d.name),
        h('span', { class: `pill ${d.busy ? 'busy' : 'free'}` }, d.busy ? `On ${d.currentOrderId}` : 'Free')
      )
    )
  );
}

// ---- New order form ----
function addItemRow(values = {}) {
  const row = h(
    'div',
    { class: 'item-row' },
    h('input', { name: 'itemName', placeholder: 'Item', required: true, value: values.name || '' }),
    h('input', { name: 'itemQty', type: 'number', min: '1', step: '1', value: values.qty || '1', 'aria-label': 'Quantity', required: true }),
    h('input', { name: 'itemPrice', type: 'number', min: '0', step: '0.01', value: values.price || '', placeholder: '$', 'aria-label': 'Unit price', required: true })
  );
  document.getElementById('items').append(row);
}

document.getElementById('add-item').addEventListener('click', () => addItemRow());

document.getElementById('order-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const items = [...document.querySelectorAll('#items .item-row')].map((row) => {
    const [name, qty, price] = row.querySelectorAll('input');
    return { name: name.value, quantity: Number(qty.value), unitPrice: Number(price.value) };
  });
  try {
    const created = await api('POST', '/api/orders', {
      customerName: form.customerName.value,
      address: form.address.value,
      items,
    });
    toast(`Order ${created.id} created`);
    form.reset();
    document.getElementById('items').replaceChildren();
    addItemRow();
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
});

addItemRow({ name: '', qty: '1', price: '' });
refresh().catch((err) => toast(err.message, true));
setInterval(() => refresh().catch(() => {}), 5000);

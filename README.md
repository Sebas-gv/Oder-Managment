# Order Management Prototype

A small web app + API for managing orders, with fictional data and in-memory storage.
Node.js (no dependencies) + HTML/CSS/JavaScript.

## Run

```bash
npm start          # http://localhost:3000  (PORT=4000 npm start for another port)
npm test           # 12 tests using node:test
```

Requires Node 18+ (tested on 22).

## State flow

`placed → accepted → assigned → picked_up → delivered`

- An order can only move to the next state. Skips, going back and repeats return **409**.
- An order can only be assigned once.
- A driver can only have one active order (`assigned` / `picked_up`); trying to assign them to another returns **409**. The driver is freed when the order becomes `delivered`.

## API

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/orders` | Create an order `{customerName, address, items:[{name, quantity, unitPrice}]}` |
| `GET` | `/api/orders[?status=placed]` | List orders |
| `GET` | `/api/orders/:id` | Order details |
| `POST` | `/api/orders/:id/status` | `{status, driverId?}` (`driverId` is required when assigning) |
| `GET` | `/api/drivers` | Drivers and whether they are busy |

Status codes: `201` created, `400` validation error, `404` not found, `409` invalid transition or driver busy.

## Structure

```
src/orderService.js   business rules (state machine, driver assignment)
src/server.js         HTTP server + API + static files
public/               frontend (index.html, style.css, app.js)
test/                 service tests and HTTP API tests
```

## A note on concurrency

`transition()` is synchronous and Node runs on a single thread, so "check driver is free + assign" is atomic
(there is a test firing 5 simultaneous requests at one driver: only one wins). With a real database you would
use a transaction or a conditional `UPDATE ... WHERE`.

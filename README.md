# Transaction Ledger API

Node.js and Express backend for accounts, credits, debits, balances, and transaction history.

## Run

```bash
npm install
npm start
```

The server listens on `http://localhost:3000` by default. Data is persisted in `data/ledger.json`.

## Endpoints

- `POST /api/accounts` — create an account. Body: `{ "name": "Ada Lovelace" }`
- `GET /api/accounts/:accountId/balance` — fetch the current balance
- `POST /api/accounts/:accountId/transactions` — add a credit or debit
- `GET /api/accounts/:accountId/transactions` — list transactions
- `GET /api/accounts/:accountId/transactions?type=credit` — filter by type
- `GET /health` — health check

Transaction body:

```json
{
  "type": "credit",
  "amount": 100,
  "description": "Opening deposit",
  "reference_id": "deposit-001"
}
```

Duplicate `reference_id` values are rejected per account with HTTP `409`. Debit transactions that exceed the current balance are rejected with HTTP `400`.

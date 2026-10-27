const ledgerRepository = require('../repositories/ledgerRepository');

function addTransaction(req, res) {
  const { accountId } = req.params;
  const { type, amount, description, reference_id: referenceId } = req.body;
  const account = ledgerRepository.findAccountById(accountId);

  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (!['credit', 'debit'].includes(type)) {
    return res.status(400).json({ error: 'type must be either credit or debit' });
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  if (typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ error: 'description is required and must be a non-empty string' });
  }
  if (typeof referenceId !== 'string' || !referenceId.trim()) {
    return res.status(400).json({ error: 'reference_id is required and must be a non-empty string' });
  }

  const existingTransaction = ledgerRepository.findTransactionByReference(accountId, referenceId);
  if (existingTransaction) {
    return res.status(409).json({
      error: 'Transaction already exists for this account and reference_id',
      transaction: existingTransaction
    });
  }

  if (type === 'debit' && account.balance < amount) {
    return res.status(400).json({
      error: 'Insufficient balance',
      balance: account.balance
    });
  }

  const result = ledgerRepository.addTransaction(
    accountId,
    type,
    amount,
    description.trim(),
    referenceId.trim()
  );
  return res.status(201).json({ ...result.transaction, balance: result.account.balance });
}

function getTransactions(req, res) {
  const { accountId } = req.params;
  const { type } = req.query;
  if (!ledgerRepository.findAccountById(accountId)) {
    return res.status(404).json({ error: 'Account not found' });
  }
  if (type && !['credit', 'debit'].includes(type)) {
    return res.status(400).json({ error: 'type must be either credit or debit' });
  }

  return res.json({ account_id: accountId, transactions: ledgerRepository.listTransactions(accountId, type) });
}

module.exports = { addTransaction, getTransactions };

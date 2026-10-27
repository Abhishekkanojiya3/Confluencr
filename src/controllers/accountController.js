const ledgerRepository = require('../repositories/ledgerRepository');

function createAccount(req, res) {
  const { name } = req.body;
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required and must be a non-empty string' });
  }

  const account = ledgerRepository.createAccount(name.trim());
  return res.status(201).json(account);
}

function getBalance(req, res) {
  const account = ledgerRepository.findAccountById(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  return res.json({ account_id: account.id, balance: account.balance });
}

module.exports = { createAccount, getBalance };

const { randomUUID } = require('crypto');
const { readDatabase, writeDatabase } = require('../config/database');

function createAccount(name) {
  const database = readDatabase();
  const account = {
    id: randomUUID(),
    name,
    balance: 0,
    created_at: new Date().toISOString()
  };
  database.accounts.push(account);
  writeDatabase(database);
  return account;
}

function findAccountById(accountId) {
  return readDatabase().accounts.find((account) => account.id === accountId);
}

function findTransactionByReference(accountId, referenceId) {
  return readDatabase().transactions.find(
    (transaction) => transaction.account_id === accountId && transaction.reference_id === referenceId
  );
}

function addTransaction(accountId, type, amount, description, referenceId) {
  const database = readDatabase();
  const account = database.accounts.find((item) => item.id === accountId);
  if (!account) return null;

  const transaction = {
    id: randomUUID(),
    account_id: accountId,
    type,
    amount,
    description,
    reference_id: referenceId,
    created_at: new Date().toISOString()
  };

  account.balance = type === 'credit' ? account.balance + amount : account.balance - amount;
  database.transactions.push(transaction);
  writeDatabase(database);
  return { account, transaction };
}

function listTransactions(accountId, type) {
  return readDatabase().transactions.filter(
    (transaction) => transaction.account_id === accountId && (!type || transaction.type === type)
  );
}

module.exports = {
  createAccount,
  findAccountById,
  findTransactionByReference,
  addTransaction,
  listTransactions
};

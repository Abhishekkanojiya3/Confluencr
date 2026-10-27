const express = require('express');
const accountRoutes = require('./routes/accountRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');

const app = express();

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/accounts', accountRoutes);
app.use('/api/accounts/:accountId/transactions', transactionRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;

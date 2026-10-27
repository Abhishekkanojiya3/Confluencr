const express = require('express');
const { createAccount, getBalance } = require('../controllers/accountController');

const router = express.Router();

router.post('/', createAccount);
router.get('/:accountId/balance', getBalance);

module.exports = router;

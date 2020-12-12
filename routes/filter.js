var express = require('express');
var router = express.Router();

/* GET users listing. */
router.use('/', function(req, res) {

  const query = req.body.input;
  const url = "??";

  res.render('index', {result: query});
});

module.exports = router;

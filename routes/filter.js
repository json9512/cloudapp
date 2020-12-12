require('dotenv').config();
const Twitter = require('twitter');
const AWS = require("aws-sdk");
const rateLimit = require("express-rate-limit");
const redis = require("redis");
const express = require('express');
const router = express.Router();

// ML library
const utf8 = require('utf8');
const Entities = require('html-entities').AllHtmlEntities;;
const entities = new Entities();
const natural = require('natural');



// Redis setup
const RedisClient = redis.createClient();
RedisClient.on("error", function(error) {
  console.error(error);
});

// rate limit setup
const TwitterSearchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // per minute
  max: 8,
  message: "Limit hit for request"
})

// Twitter credentials setup
const TwitterClient = new Twitter({
  consumer_key: process.env.API_KEY,
  consumer_secret: process.env.SECRET_KEY,
  bearer_token: process.env.BEARER_TOKEN
})

// S3 bucket setup
const bucketName = 'n9706909-assignment2-test';
const bucketPromise = new AWS.S3({ apiVersion: '2006-03-01'}).createBucket({ Bucket: bucketName}).promise();
 bucketPromise.then(function(data) { 
    console.log("Successfully created " + bucketName);
})
.catch(function(err) {
    console.error(err, err.stack);
}); 

// ML Setup
// Threshold for sentiment analysis
const positiveThreshold = (x) => {return x.sentiment > 0.05}
const negativeThreshold = (x) => {return x.sentiment < -0.05}
const neutralThreshold = (x) => {return x.sentiment < 0.05 && x.sentiment > -0.05}

const calculateAvg = (arr) => {
    let sum = 0;
    arr.forEach(item => {
        sum += item.sentiment
    })

    return sum / arr.length;
}

const getNTweets = (arr, n) => {
    let arrSliced = null;
    if (arr.length > n){
        arrSliced = arr.slice(0, n)
    }else{
        arrSliced = arr
    }

    let final = [];
    arrSliced.forEach(item=>{
        final.push(item.tweet)
    })

    return final
}

const constructObj = (arr, n, type) => {
    let avg = calculateAvg(arr)
    let message = `Most of the tweets related to the query is ${type}: ${avg.toFixed(2)} average score`
    
    let obj = {
        "tweets" : getNTweets(arr, n), message: message
    }
    return obj
}

//////////////////////////
router.use('/', TwitterSearchLimiter , function(req, res) {
  
  // Create variables and initialize ML components
  let finalData = {};
  let resultarray = [];

  const tokenizer = new natural.WordTokenizer();
  const Analyzer = require('natural').SentimentAnalyzer;
  const stemmer = require('natural').PorterStemmer;
  const analyzer = new Analyzer("English", stemmer, "afinn");
  const TfIdf = natural.TfIdf;
  const tfidf = new TfIdf();

  // Retrieve query and setup redis key
  const query = req.body.input;
  const redisKey = `twitter:${query}`;
  console.log(query);

  if (query === "" || query === undefined){
    console.log("No input");
    return res.status(400).render('index', {error: 'Sorry, but you need to add some input' });
  }

  
  // check redis first
  return RedisClient.get(redisKey, (err, redisresult) => {
    // if key in redis
    if (redisresult){
      const data = JSON.parse(redisresult);
      console.log("[INFO] Data found in Redis")
      console.log(data)
      res.render('result', {result: data});
    }
    else{

      // check S3
      const s3Key = `twitter-${query}`;
      const params = { Bucket: bucketName, Key: s3Key};

      return new AWS.S3({ apiVersion: '2006-03-01'}).getObject(params, (err  , result) =>  {

        if (result) {

          //console.log("result - " + result.Body);

          // Save the S3 into Redis store
          RedisClient.set(redisKey, result.Body, function(err, reply){
            console.log("redis - " + reply);
          });
          console.log("[INFO] Data found in S3")
          let data = JSON.parse(result.Body)
          console.log(data)
          res.render('result', {result: data});
        } 
        else{
          TwitterClient.get('https://api.twitter.com/1.1/search/tweets.json', {q: query, lang: 'en', count: 100}, function(error, tweets, response){

            if(error) return res.render('index', {error: "Error ! Search failed, please check your input"});

            for (let i = 0; i < tweets.statuses.length; i++){
              // check if tweet is not a retweet
              if (tweets.statuses[i].retweet_count == 0){
                resultarray.push(tweets.statuses[i].text);
              }
            }

            // ML and d3

            console.log("[INFO] Processing Tweets ...\n")
            let dataArr = [];
            resultarray.forEach(tweet => {
              dataArr.push(entities.decode(utf8.decode(utf8.encode(tweet))).split("http")[0]);
            })


            // 1. Tweets must be tokenized for sentiment analysis
            let dataTok = [];

            // Tokenize tweets
            dataArr.forEach((sen, idx) => {
                let tokenized = tokenizer.tokenize(sen)
                // Store the tweet and its sentiment score
                dataTok.push({"tweet": sen, "sentiment":analyzer.getSentiment(tokenized) })
            });

            // Find the overall sentiment of this result tweets
            let positive = dataTok.filter(positiveThreshold)
            let negative = dataTok.filter(negativeThreshold)
            let neutral = dataTok.filter(neutralThreshold)
            
            if (positive.length > negative.length && positive.length > neutral.length){
                //console.log(positive)
                finalData.sentiment = constructObj(positive, 10, "Positive")

            }else if (negative.length > positive.length && negative.length > neutral.length){
                //console.log(negative)
                finalData.sentiment = constructObj(negative, 10, "Negative")

            } else if (neutral.length > positive.length && negative.length < neutral.length){
                //console.log(neutral)
                
                finalData.sentiment = constructObj(neutral, 10, "Neutral")
            } else {
                finalData.sentiment = constructObj(neutral, 10, "Neutral")
            }
            
            // Do tf-idf
            // Append all tweets into a single document
            let doc = ""
            dataArr.forEach((sen) => {
                doc += "\n" + sen
            })
            
            // Add the doc to tfidf handler
            tfidf.addDocument(doc)

            // get items that have appeared more than 0.5% of the doc
            let len = 0.5
            if (tfidf.listTerms(0).length > 1000){
              len = 1
            }

            let tfidfDoc = tfidf.listTerms(0).filter((item) => {return item.tfidf > len})    

            // Sort descending and cut off the first 3 elements -> Most appeared likely means not important. eg. .com, .org etc
            tfidfDoc.sort(function(a, b){return b.tfidf - a.tfidf})
            tfidfDoc.splice(0, 3)

            let d3words = []
            let n = tfidfDoc.length

            if (n < 10){
                n = 40
            }
            tfidfDoc.forEach(item => {
                if (n < 20){
                    n = 20
                }else{
                    n -= 1
                }

                d3words.push({"word": item.term, "size": n})
            })

            
            finalData.wordcloud = JSON.stringify(d3words)

            console.log(finalData)

            // Store in Redis and S3
            RedisClient.set(redisKey, JSON.stringify(finalData), function(err, reply){
              console.log("redis - " + reply);
            });
            
            const objectParams = {Bucket: bucketName, Key: s3Key, Body: JSON.stringify(finalData)};
            const uploadPromise = new AWS.S3({apiVersion: '2006-03-01'}).putObject(objectParams).promise();
            uploadPromise.then(function(data) {
                console.log("Successfully uploaded data to " + bucketName + "/" + s3Key);
            });

            res.render('result', {result: finalData});
          })
        }
      });
    }
  })
});

module.exports = router;

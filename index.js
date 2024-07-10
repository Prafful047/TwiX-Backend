require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const bodyParser = require('body-parser');
const cors = require('cors');
const nodemailer = require('nodemailer');
const requestIp = require('request-ip');
const UAParser = require('ua-parser-js')
const useragent = require('express-useragent');
const { MongoClient, ServerApiVersion } = require('mongodb');
const axios = require('axios');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const port = process.env.PORT || 5000;

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  tls: true,
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,

  }
});

const otps = {};

async function run() {
  try {
    await client.connect();
    console.log("Connected to MongoDB");
    const postCollection = client.db('database').collection('posts');
    const userCollection = client.db('database').collection('users');

    app.use(cors());
    // app.use(express.json());
    app.use(useragent.express());
    app.use(requestIp.mw());
    app.use('/webhook', bodyParser.raw({ type: 'application/json' }));

    app.use(express.json());

    // app.use(bodyParser.json());

    app.get('/check-access', (req, res) => {
      const parser = new UAParser(req.headers['user-agent']);
      const deviceType = parser.getDevice().type;
    
      const isMobile = deviceType === 'mobile' || deviceType === 'tablet';
      const startTime = 9;
      const endTime = 17;
      const currentTime = new Date().getHours();
    
      if (isMobile && (currentTime < startTime || currentTime >= endTime)) {
        return res.json({ accessAllowed: false });
      }
    
      res.json({ accessAllowed: true });
    });


    app.get('/', (req, res) => {
      res.send('Hello from Twitter!');
    });

    app.get('/post', async (req, res) => {
      const post = (await postCollection.find().toArray()).reverse();
      res.send(post);
    });

    app.get('/user', async (req, res) => {
      const user = await userCollection.find().toArray();
      res.send(user);
    });

    app.get('/loggedInUser', async (req, res) => {
      const email = req.query.email;
      const user = await userCollection.find({ email }).toArray();
      res.send(user);
    });

    app.get('/userPost', async (req, res) => {
      const email = req.query.email;
      const post = (await postCollection.find({ email }).toArray()).reverse();
      res.send(post);
    });

    app.post('/post', async (req, res) => {
      const post = req.body;
      const result = await postCollection.insertOne(post);
      res.send(result);
    });

    app.post('/register', async (req, res) => {
      const user = req.body;
      user.loginHistory = []; 
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.post('/login', async (req, res) => {
      const { email, password } = req.body;
      const user = await userCollection.findOne({ email });

      if (user) {
        // Validate password (Assuming you have password validation logic)
        // ...

        const parser = new UAParser(req.headers['user-agent']);
        const uaResult = parser.getResult();
        const currentBrowser = uaResult.browser.name;
        const currentPlatform = uaResult.os.name;

        const loginHistory = user.loginHistory || [];
        const lastLogin = loginHistory[loginHistory.length - 1];

        if (lastLogin && (lastLogin.browser !== currentBrowser || lastLogin.platform !== currentPlatform)) {
          await axios.post(`${process.env.BACKEND_URL}/send-otp`, { email });
          return res.json({ success: true, otpRequired: true });
        }

        res.json({ success: true });
      } else {
        res.status(400).json({ success: false, message: 'Invalid email or password' });
      }
    });

    app.post('/google-login', async (req, res) => {
      const { email } = req.body;
      const user = await userCollection.findOne({ email });

      if (user) {
        const parser = new UAParser(req.headers['user-agent']);
        const uaResult = parser.getResult();
        const currentBrowser = uaResult.browser.name;
        const currentPlatform = uaResult.os.name;

        const loginHistory = user.loginHistory || [];
        const lastLogin = loginHistory[loginHistory.length - 1];

        // console.log(lastLogin);

        if (lastLogin && (lastLogin.browser !== currentBrowser || lastLogin.platform !== currentPlatform)) {
          await axios.post(`${process.env.BACKEND_URL}/send-otp`, { email });
          return res.json({ success: true, otpRequired: true });
        }

        res.json({ success: true });
      } else {
        const newUser = { email, loginHistory: [] };
        await userCollection.insertOne(newUser);
        res.json({ success: true });
      }
    });



    app.post('/login-history', async (req, res) => {
      const { email } = req.body;
      const timestamp = new Date().toLocaleString();
      const parser = new UAParser(req.headers['user-agent']);
      const uaResult = parser.getResult();
      const browser = uaResult.browser.name;
      const os = uaResult.os.name;
      const platform = uaResult.os.name;
      const ip = req.clientIp;

      try {
        const result = await userCollection.updateOne(
          { email },
          { $push: { loginHistory: { timestamp, browser, os, platform, ip } } }
        );
        res.json({ success: true, result });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    app.post('/send-otp', async (req, res) => {
      const { email } = req.body;
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      otps[email] = { otp, expires: Date.now() + 300000 };

      const transporter = nodemailer.createTransport({
        service: 'Gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });

      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Your OTP Code',
        text: `Your OTP is ${otp}. It is valid for 5 minutes.`,
      };

      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          return res.status(500).json({ success: false, error: error.message });
        } else {
          res.json({ success: true, message: 'OTP sent to email' });
        }
      });
    });

    app.post('/verify-otp', async (req, res) => {
      const { email, otp } = req.body;
      const storedOtp = otps[email];

      if (storedOtp && storedOtp.otp === otp && Date.now() < storedOtp.expires) {
        const parser = new UAParser(req.headers['user-agent']);
        const uaResult = parser.getResult();
        const loginEvent = {
          email,
          timestamp: new Date(),
          browser: uaResult.browser.name,
          os: uaResult.os.name,
          platform: uaResult.os.name,
          ip: req.clientIp,
        };
        await userCollection.updateOne(
          { email },
          { $push: { loginHistory: loginEvent } }
        );

        delete otps[email];
        res.json({ success: true });
      } else {
        res.status(400).json({ success: false, error: 'Invalid OTP' });
      }
    });

    app.get('/login-history', async (req, res) => {
      const email = req.query.email;
      const user = await userCollection.findOne({ email }, { projection: { loginHistory: 1 } });
      if (user) {
        res.json(user.loginHistory);
      } else {
        res.status(404).json({ message: 'User not found' });
      }
    });

    app.post('/create-checkout-session', async (req, res) => {
      const { priceId, email } = req.body;

      try {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          customer_email: email,
          line_items: [{
            price: priceId,
            quantity: 1,
          }],
          mode: 'subscription',
          success_url: `${process.env.FRONTEND_URL}/success`,
          cancel_url: `${process.env.FRONTEND_URL}/cancel`,
        });

        res.json({ id: session.id });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
      const sig = req.headers['stripe-signature'];
      let event;

      try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
      } catch (err) {
        console.log(`Webhook signature verification failed.`, err.message);
        return res.sendStatus(400);
      }

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;

        const email = session.customer_email;
        const subscriptionId = session.subscription;

        try {
          const result = await userCollection.updateOne(
            { email },
            { $set: { subscription: subscriptionId } },
            { upsert: true }
          );
          console.log('User subscription updated:', result);
        } catch (err) {
          console.error('Error updating user subscription:', err);
        }

        const transporter = nodemailer.createTransport({
          service: 'Gmail',
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
          },
        });

        const mailOptions = {
          from: process.env.EMAIL_USER,
          to: session.customer_email,
          subject: 'Subscription Created',
          text: `Your subscription has been created successfully.\n\n
          Details:\n
          - Subscription ID: ${session.subscription}\n
          - Customer Email: ${session.customer_email}\n
          - Plan Price : ${session.amount_total / 100}
          Thank you for subscribing to our service!`,
        };

        transporter.sendMail(mailOptions, (error, info) => {
          if (error) {
            console.error('Error sending email:', error);
          } else {
            console.log('Email sent:', info.response);
          }
        });
      }

      res.json({ received: true });
    });

    app.patch('/userUpdates/:email', async (req, res) => {
      const filter = { email: req.params.email };
      const profile = req.body;
      const options = { upsert: true };
      const updateDoc = { $set: profile };
      const result = await userCollection.updateOne(filter, updateDoc, options);
      res.send(result);
    });

  } catch (error) {
    console.log(error);
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Twitter backend listening on port ${port}`);
});
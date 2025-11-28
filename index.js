const express = require('express');
const cors = require('cors');
const app = express();
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);

const port = process.env.PORT || 3000;

// Middleeare
app.use(cors());
app.use(express.json());

app.use(async (req, res, next) => {
    console.log(
        `⚡ ${req.method} - ${req.path} from ${req.host} at ⌛ ${new Date().toLocaleString()}`
    );
    next();
});


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.qrthjko.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});


async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        // await client.connect();

        const db = client.db('zap_shift_db');
        const parcelsCollections = db.collection('parcels');

        // :::::::::::::::::::::::::::::: - Parcel API - ::::::::::::::::::::::::::::::
        // Get API
        app.get('/parcels', async (req, res) => {
            const query = {};
            const { email } = req.query;

            if (email) {
                query.senderEmail = email;
            }

            const options = { sort: { created_at: -1 } }

            const cursor = parcelsCollections.find(query, options);
            const result = await cursor.toArray();
            res.send(result);
        });

        // Get API for single data
        app.get('/parcels/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await parcelsCollections.findOne(query);
            res.send(result);
        });

        // Post API
        app.post('/parcels', async (req, res) => {
            const parcel = req.body;
            const result = await parcelsCollections.insertOne(parcel);
            res.send(result);
        });

        // Delete API
        app.delete('/parcels/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };

            const result = await parcelsCollections.deleteOne(query);
            res.send(result);
        });

        // :::::::::::::::::::::::::::::: - Payment Related APIS - ::::::::::::::::::::::::::::::
        // create stripe checkout session
        app.post('/create-checkout-session', async (req, res) => {
            const paymentInfo = req.body;
            const amount = parseInt(paymentInfo.cost) * 100;

            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        price_data: {
                            currency: 'USD',
                            unit_amount: amount,
                            product_data: {
                                name: `Please pay for: ${paymentInfo.parcleName}`
                            }
                        },
                        quantity: 1,
                    },
                ],
                customer_email: paymentInfo.senderEmail,
                mode: 'payment',
                metadata: {
                    parcelId: paymentInfo.parcelId
                },
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled?cancelled=true`,
            });

            res.send({ url: session.url });
        });

        app.patch('/payment-success', async (req, res) => {
            const sessionId = req.query.session_id;

            const session = await stripe.checkout.sessions.retrieve(sessionId);

            if (session.payment_status === 'paid') {
                const id = session.metadata.parcelId;
                const query = { _id: new ObjectId(id) };
                const update = {
                    $set: {
                        paymentStatus: 'paid'
                    }
                }

                const result = await parcelsCollections.updateOne(query, update);
                res.send(result);
            }

            res.send({ success: false });
        });

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);

// Basic Routes
app.get('/', (req, res) => {
    res.send({ status: 'ok', message: 'Zap Shift Server' });
});

// 404
app.all(/.*/, (req, res) => {
    res.status(404).json({
        status: 404,
        error: 'API not found',
    });
});

app.listen(port, () => {
    console.log(`Zap Shift server is running on port: ${port}`);
});
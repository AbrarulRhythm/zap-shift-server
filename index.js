const express = require('express');
const cors = require('cors');
const app = express();
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);

const port = process.env.PORT || 3000;
const crypto = require('crypto');

const admin = require("firebase-admin");

const serviceAccount = require("./zap-shift-firebase-adminsdk.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

// Generate Tracking Id
function generateTrackingId() {
    const prefix = 'zap'; // brand prefix
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
    const random = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 char random hex

    return `${prefix}_${date}_${random}`;
}

// Middleeare
app.use(cors());
app.use(express.json());

const verifyFBToken = async (req, res, next) => {
    const token = req.headers?.authorization;

    if (!token) {
        return res.status(401).send({ message: 'unauthorized access' });
    }

    try {
        const idToken = token.split(' ')[1];
        const decoded = await admin.auth().verifyIdToken(idToken);
        req.decoded_email = decoded.email;

        next();
    }
    catch (error) {
        return res.status(401).send({ message: 'unauthorized access' });
    }
}

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
        const usersCollections = db.collection('users');
        const parcelsCollections = db.collection('parcels');
        const paymentCollection = db.collection('payments');
        const ridersCollection = db.collection('riders');
        const trackingsCollection = db.collection('trackings');

        // Middle ware admin before allowing admin activity
        // must be use after verifyFirebaseToken middle ware
        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded_email;
            const query = { email };
            const user = await usersCollections.findOne(query);

            if (!user || user.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden accress' });
            }

            next();
        }

        // Tracking Log
        const logTracking = async (trackingId, status) => {
            const log = {
                trackingId,
                status,
                details: status.split('_').join(' '),
                createdAt: new Date()
            }
            const result = await trackingsCollection.insertOne(log);
            return result;
        }

        // :::::::::::::::::::::::::::::: - User Related APIS - ::::::::::::::::::::::::::::::
        // Get API
        app.get('/users', verifyFBToken, async (req, res) => {
            const searchText = req.query.searchText;
            const query = {};

            if (searchText) {
                // query.displayName = { $regex: searchText, $options: 'i' };

                query.$or = [
                    { displayName: { $regex: searchText, $options: 'i' } },
                    { email: { $regex: searchText, $options: 'i' } }
                ]
            }

            const cursor = usersCollections.find(query).sort({ createdAt: -1 }).limit(10);
            const result = await cursor.toArray();
            res.send(result);
        });

        // Get APi for user role
        app.get('/users/:email/role', async (req, res) => {
            const email = req.params.email;
            const query = { email };
            const user = await usersCollections.findOne(query);
            res.send({ role: user?.role || 'user' });
        });

        // Post API
        app.post('/users', async (req, res) => {
            const user = req.body;
            user.role = 'user'; // Default user role
            user.createdAt = new Date();

            const email = user.email;
            const userExist = await usersCollections.findOne({ email });

            if (userExist) {
                return res.send({ message: '⚡You already exist. Signed in successfully.' });
            }

            const result = await usersCollections.insertOne(user);
            res.send(result);

        });

        // Patch API
        app.patch('/users/:id/role', verifyFBToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const roleInfo = req.body;
            const query = { _id: new ObjectId(id) };
            const updatedDoc = {
                $set: {
                    role: roleInfo.role
                }
            }
            const result = await usersCollections.updateOne(query, updatedDoc);
            res.send(result);
        });

        // :::::::::::::::::::::::::::::: - Parcel Related APIS - ::::::::::::::::::::::::::::::
        // Get API
        app.get('/parcels', async (req, res) => {
            const query = {};
            const { email, deliveryStatus } = req.query;

            if (email) {
                query.senderEmail = email;
            }

            if (deliveryStatus) {
                query.deliveryStatus = deliveryStatus;
            }

            const options = { sort: { created_at: -1 } }

            const cursor = parcelsCollections.find(query, options);
            const result = await cursor.toArray();
            res.send(result);
        });

        // Get API (Riders)
        app.get('/parcels/rider', async (req, res) => {
            const { riderEmail, deliveryStatus } = req.query;
            const query = {};

            if (riderEmail) {
                query.riderEmail = riderEmail;
            }
            if (deliveryStatus !== 'parcel_delivered') {
                query.deliveryStatus = { $nin: ['parcel_delivered'] };
            }
            else {
                query.deliveryStatus = deliveryStatus;
            }

            const cursor = parcelsCollections.find(query);
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
            const trackingId = generateTrackingId();
            parcel.createdAt = new Date();
            parcel.trackingId = trackingId;

            logTracking(trackingId, 'parcel_created');

            const result = await parcelsCollections.insertOne(parcel);
            res.send(result);
        });

        // Patch API for assign rider
        app.patch('/parcels/:id', async (req, res) => {
            const { riderId, riderName, riderEmail, trackingId } = req.body;
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };

            const updatedDoc = {
                $set: {
                    deliveryStatus: 'driver_assigned',
                    riderId: riderId,
                    riderName: riderName,
                    riderEmail: riderEmail
                }
            }

            const result = await parcelsCollections.updateOne(query, updatedDoc);

            // Update Rider Information
            const riderQuery = { _id: new ObjectId(riderId) };
            const riderUpdatedDoc = {
                $set: {
                    workStatus: 'in_delivery'
                }
            }

            const riderResult = await ridersCollection.updateOne(riderQuery, riderUpdatedDoc);

            // Log Tracking
            logTracking(trackingId, 'driver_assigned');

            res.send(riderResult);
        });

        // Patch API for update delivery status
        app.patch('/parcels/:id/status', async (req, res) => {
            const { deliveryStatus, riderId, trackingId } = req.body;
            const query = { _id: new ObjectId(req.params.id) };
            const updatedDoc = {
                $set: {
                    deliveryStatus: deliveryStatus
                }
            }

            if (deliveryStatus === 'parcel_delivered') {
                // Update Rider Information
                const riderQuery = { _id: new ObjectId(riderId) };
                const riderUpdatedDoc = {
                    $set: {
                        workStatus: 'available'
                    }
                }

                const riderResult = await ridersCollection.updateOne(riderQuery, riderUpdatedDoc);
            }

            const result = await parcelsCollections.updateOne(query, updatedDoc);

            // Log Tracking
            logTracking(trackingId, deliveryStatus);

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
                    parcelId: paymentInfo.parcelId,
                    parcleName: paymentInfo.parcleName,
                    trackingId: paymentInfo.trackingId
                },
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled?cancelled=true`,
            });

            res.send({ url: session.url });
        });

        // Payment Success API
        app.patch('/payment-success', async (req, res) => {
            const sessionId = req.query.session_id;

            const session = await stripe.checkout.sessions.retrieve(sessionId);

            const transactionId = session.payment_intent;
            const query = { transactionId: transactionId }
            const paymentExist = await paymentCollection.findOne(query);

            if (paymentExist) {
                return res.send({
                    message: 'already exists',
                    transactionId,
                    trackingId: paymentExist.trackingId
                });
            }

            // use the previous tracking id created during the parcel create which was set to the session metadata during session creation
            const trackingId = session.metadata.trackingId;

            if (session.payment_status === 'paid') {
                const id = session.metadata.parcelId;
                const query = { _id: new ObjectId(id) };
                const update = {
                    $set: {
                        paymentStatus: 'paid',
                        deliveryStatus: 'pending_pickup'
                    }
                }

                const result = await parcelsCollections.updateOne(query, update);

                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customerEmail: session.customer_email,
                    parcelId: session.metadata.parcelId,
                    parcleName: session.metadata.parcleName,
                    transactionId: session.payment_intent,
                    paymentStatus: session.payment_status,
                    trackingId: trackingId,
                    paidAt: new Date()
                }

                if (session.payment_status === 'paid') {
                    const resultPayment = await paymentCollection.insertOne(payment);

                    logTracking(trackingId, 'parcel_paid');

                    res.send({
                        success: true,
                        modifyParcel: result,
                        trackingId: trackingId,
                        transactionId: session.payment_intent,
                        paymentInfo: resultPayment
                    });
                }
            }

            res.send({ success: false });
        });

        // Payment History GET API
        app.get('/payments', verifyFBToken, async (req, res) => {
            const email = req.query.email;
            const query = {}

            if (email) {
                query.customerEmail = email;

                // check email address
                if (email !== req.decoded_email) {
                    return res.status(403).send({ message: 'forbidden access' });
                }
            }

            const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
            const result = await cursor.toArray();
            res.send(result);
        });

        // :::::::::::::::::::::::::::::: - Riders Related APIS - ::::::::::::::::::::::::::::::
        // Get API
        app.get('/riders', verifyFBToken, async (req, res) => {
            const { status, district, workStatus } = req.query;
            const query = {};

            if (status) {
                query.status = status;
            }

            if (district) {
                query.district = district;
            }

            if (workStatus) {
                query.workStatus = workStatus;
            }

            const cursor = ridersCollection.find(query);
            const result = await cursor.toArray();
            res.send(result);
        });

        // Post API
        app.post('/riders', async (req, res) => {
            const rider = req.body;
            rider.status = 'pending',
                rider.createdAt = new Date();

            const result = await ridersCollection.insertOne(rider);
            res.send(result);
        });

        // Patch API
        app.patch('/riders/:id', verifyFBToken, verifyAdmin, async (req, res) => {
            const status = req.body.status;
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const updatedDoc = {
                $set: {
                    status: status,
                    workStatus: 'available'
                }
            }

            const result = await ridersCollection.updateOne(query, updatedDoc);

            if (status === 'approved') {
                const email = req.body.email;
                const userQuery = { email };
                const updateUser = {
                    $set: {
                        role: 'rider'
                    }
                }
                const userResult = await usersCollections.updateOne(userQuery, updateUser);
            }

            res.send(result);
        });

        // :::::::::::::::::::::::::::::: - Tracking Related APIS - ::::::::::::::::::::::::::::::
        // Get API
        app.get('/trackings/:trackingID/logs', async (req, res) => {
            const trackingId = req.params.trackingID;
            const query = { trackingId };
            const result = await trackingsCollection.find(query).toArray();
            res.send(result);
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
# ShopSphere - Multi-Vendor E-Commerce Platform (Microservices)

SPARKIIT Internship - Project 2. Author: SINCHANA RAVI GOWDA.

## Features
- **Vendor dashboard** - sales stats, 7-day revenue chart, top products, product CRUD, order fulfilment.
- **Product listing + filtering** - search, category, vendor, price range, in-stock, sorting, pagination.
- **Cart + checkout** - quantity control, coupons (WELCOME10, FLAT100, FREESHIP), 18% GST, shipping rules, COD / test card / test UPI.
- **Order tracking + invoice** - per-item status flow (Placed > Confirmed > Packed > Shipped > Delivered), cancellation, PDF invoice.

## Architecture
```
Browser -> API Gateway :4000 -> user-service    :4001 (users.db)
                             -> catalog-service :4002 (catalog.db)
                             -> order-service   :4003 (orders.db)
```
Each service is a separate process with its own database. JWT auth is verified in every service; services talk to
each other over `/internal/*` routes protected by a shared key that the gateway never exposes. Stock is reserved
atomically (SQLite `BEGIN IMMEDIATE`) so two buyers cannot take the last unit. Money is stored as integer paise.

## Run (Windows / Mac / Linux) - needs Node.js 22.13+
```
npm install
npm start
```
Open http://localhost:4000. Demo data loads automatically.

| Role | Email | Password |
|---|---|---|
| Customer | demo@shop.test | Demo@1234 |
| Vendor (TechHub) | techhub@shop.test | Vendor@123 |
| Vendors | fashionista@ / homenest@ / pageturner@shop.test | Vendor@123 |

## Tests
`npm test` starts the services on temporary ports and runs 80 end-to-end checks.

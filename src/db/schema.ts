import {
  pgTable,
  text,
  integer,
  timestamp,
  uuid,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

/**
 * Every table below hangs off `rep_id`. That is the portability guarantee:
 * a rep's entire world can be selected, exported, or moved with one predicate.
 */

export const reps = pgTable(
  "reps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    businessName: text("business_name").notNull(),
    // Public handle used in the customer invite link: /r/{slug}
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("reps_email_unique").on(t.email),
    uniqueIndex("reps_slug_unique").on(t.slug),
  ],
);

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repId: uuid("rep_id")
      .notNull()
      .references(() => reps.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Email or phone — the customer picks, we don't care which.
    contact: text("contact").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("customers_rep_idx").on(t.repId),
    // Re-identifying on the same rep + contact returns the same customer,
    // so a customer who clears their cookie keeps their history.
    uniqueIndex("customers_rep_contact_unique").on(t.repId, t.contact),
  ],
);

/**
 * Rep-only private notes. There is no customer-facing read path to this table
 * anywhere in the app — see src/lib/customer-session.ts for the boundary.
 */
export const customerNotes = pgTable(
  "customer_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repId: uuid("rep_id")
      .notNull()
      .references(() => reps.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("customer_notes_customer_idx").on(t.customerId)],
);

export const REQUEST_STATUSES = [
  "draft",
  "received",
  "quoted",
  "ordered",
  "declined",
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/**
 * `draft` is the customer's live basket and is never shown to the rep.
 * Submitting flips it to `received`, which is the first rep-visible state.
 */
export const requests = pgTable(
  "requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repId: uuid("rep_id")
      .notNull()
      .references(() => reps.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("draft").$type<RequestStatus>(),
    // Free-text message the customer attaches at submit time.
    customerMessage: text("customer_message"),
    // Rep's reply back to the customer (e.g. "quoted, $1,240 inc GST").
    repMessage: text("rep_message"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("requests_rep_status_idx").on(t.repId, t.status),
    index("requests_customer_idx").on(t.customerId),
  ],
);

export const requestItems = pgTable(
  "request_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url"),
    title: text("title").notNull(),
    imageUrl: text("image_url"),
    // Text, not numeric: scraped prices are messy ("$1,299.00 inc GST", "From $899").
    price: text("price"),
    quantity: integer("quantity").notNull().default(1),
    customerNote: text("customer_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("request_items_request_idx").on(t.requestId)],
);

export const favourites = pgTable(
  "favourites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repId: uuid("rep_id")
      .notNull()
      .references(() => reps.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url"),
    title: text("title").notNull(),
    imageUrl: text("image_url"),
    price: text("price"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("favourites_customer_idx").on(t.customerId)],
);

export const repsRelations = relations(reps, ({ many }) => ({
  customers: many(customers),
  requests: many(requests),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  rep: one(reps, { fields: [customers.repId], references: [reps.id] }),
  requests: many(requests),
  notes: many(customerNotes),
  favourites: many(favourites),
}));

export const requestsRelations = relations(requests, ({ one, many }) => ({
  rep: one(reps, { fields: [requests.repId], references: [reps.id] }),
  customer: one(customers, {
    fields: [requests.customerId],
    references: [customers.id],
  }),
  items: many(requestItems),
}));

export const requestItemsRelations = relations(requestItems, ({ one }) => ({
  request: one(requests, {
    fields: [requestItems.requestId],
    references: [requests.id],
  }),
}));

export type Rep = typeof reps.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type CustomerNote = typeof customerNotes.$inferSelect;
export type Request = typeof requests.$inferSelect;
export type RequestItem = typeof requestItems.$inferSelect;
export type Favourite = typeof favourites.$inferSelect;

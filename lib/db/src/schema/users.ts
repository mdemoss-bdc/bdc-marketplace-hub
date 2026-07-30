import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Persistent auth accounts — mirrors Python `users` + Node `api/_lib/db-pg.js`.
 * Synced on startup via CREATE TABLE IF NOT EXISTS in the Node auth store.
 */
export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("Reviewer"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  email: text("email").default(""),
  phone: text("phone").default(""),
  fullName: text("full_name").default(""),
  isAdmin: integer("is_admin").notNull().default(0),
  isMasterAdmin: integer("is_master_admin").notNull().default(0),
  subscriptionStatus: text("subscription_status").default("inactive"),
  subscriptionTier: text("subscription_tier").default(""),
  orgRole: text("org_role").default(""),
  organizationId: integer("organization_id"),
  emailVerified: integer("email_verified").notNull().default(1),
  isSuspended: integer("is_suspended").notNull().default(0),
  recoveryId: text("recovery_id").default(""),
  mockRole: text("mock_role").default(""),
});

export type User = typeof usersTable.$inferSelect;
export type InsertUser = typeof usersTable.$inferInsert;

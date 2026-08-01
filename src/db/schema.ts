import { pgTable, foreignKey, unique, check, uuid, text, integer, timestamp, index, jsonb, boolean, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const bookingStatus = pgEnum("booking_status", ['pending_payment', 'confirmed', 'completed', 'expired', 'refunded_manual'])
export const courtEnvironment = pgEnum("court_environment", ['indoor', 'outdoor'])
export const courtStatus = pgEnum("court_status", ['pending', 'approved', 'rejected', 'suspended'])
export const payoutStatus = pgEnum("payout_status", ['pending', 'paid'])
export const platformFeeMode = pgEnum("platform_fee_mode", ['percentage', 'flat'])
export const processorFeeBearer = pgEnum("processor_fee_bearer", ['player', 'owner', 'platform'])
export const userRole = pgEnum("user_role", ['player', 'owner', 'admin'])


export const profiles = pgTable("profiles", {
	id: uuid().primaryKey().notNull(),
	email: text().notNull(),
	fullName: text("full_name"),
	avatarUrl: text("avatar_url"),
	role: userRole().default('player').notNull(),
	phone: text(),
	businessName: text("business_name"),
	businessLogoPath: text("business_logo_path"),
	slug: text(),
	platformFeeMode: platformFeeMode("platform_fee_mode"),
	platformFeeValue: integer("platform_fee_value"),
	processorFeeBearer: processorFeeBearer("processor_fee_bearer"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.id],
			foreignColumns: [users.id],
			name: "profiles_id_fkey"
		}).onDelete("cascade"),
	unique("profiles_slug_key").on(table.slug),
	check("profiles_fee_override_pair", sql`((platform_fee_mode IS NULL) AND (platform_fee_value IS NULL)) OR ((platform_fee_mode IS NOT NULL) AND (platform_fee_value IS NOT NULL) AND (platform_fee_value > 0))`),
]);

export const branches = pgTable("branches", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerId: uuid("owner_id").notNull(),
	name: text().notNull(),
	slug: text().notNull(),
	description: text(),
	address: text().notNull(),
	city: text().notNull(),
	// TODO: failed to parse database type 'geography'
	location: unknown("location"),
	amenities: text().array().default([""]).notNull(),
	contactPhone: text("contact_phone"),
	contactEmail: text("contact_email"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("branches_city_idx").using("btree", table.city.asc().nullsLast().op("text_ops")),
	index("branches_location_gix").using("gist", table.location.asc().nullsLast().op("gist_geography_ops")),
	index("branches_owner_id_idx").using("btree", table.ownerId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.ownerId],
			foreignColumns: [profiles.id],
			name: "branches_owner_id_fkey"
		}).onDelete("cascade"),
	unique("branches_slug_key").on(table.slug),
]);

export const courts = pgTable("courts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	branchId: uuid("branch_id").notNull(),
	name: text().notNull(),
	environment: courtEnvironment().notNull(),
	surface: text(),
	status: courtStatus().default('pending').notNull(),
	rejectionReason: text("rejection_reason"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("courts_branch_approved_idx").using("btree", table.branchId.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'approved'::court_status)`),
	index("courts_branch_id_idx").using("btree", table.branchId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.branchId],
			foreignColumns: [branches.id],
			name: "courts_branch_id_fkey"
		}).onDelete("cascade"),
]);

export const branchPhotos = pgTable("branch_photos", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	branchId: uuid("branch_id").notNull(),
	storagePath: text("storage_path").notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
}, (table) => [
	index("branch_photos_branch_id_idx").using("btree", table.branchId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.branchId],
			foreignColumns: [branches.id],
			name: "branch_photos_branch_id_fkey"
		}).onDelete("cascade"),
]);

export const courtPhotos = pgTable("court_photos", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	courtId: uuid("court_id").notNull(),
	storagePath: text("storage_path").notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
}, (table) => [
	index("court_photos_court_id_idx").using("btree", table.courtId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.courtId],
			foreignColumns: [courts.id],
			name: "court_photos_court_id_fkey"
		}).onDelete("cascade"),
]);

export const courtRateBands = pgTable("court_rate_bands", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	courtId: uuid("court_id").notNull(),
	startHour: integer("start_hour").notNull(),
	endHour: integer("end_hour").notNull(),
	priceCentavos: integer("price_centavos").notNull(),
}, (table) => [
	index("court_rate_bands_court_id_idx").using("btree", table.courtId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.courtId],
			foreignColumns: [courts.id],
			name: "court_rate_bands_court_id_fkey"
		}).onDelete("cascade"),
	check("court_rate_bands_end_hour_check", sql`(end_hour > 0) AND (end_hour <= 24)`),
	check("court_rate_bands_hour_order", sql`end_hour > start_hour`),
	check("court_rate_bands_price_centavos_check", sql`price_centavos > 0`),
	check("court_rate_bands_start_hour_check", sql`(start_hour >= 0) AND (start_hour < 24)`),
]);

export const courtOperatingHours = pgTable("court_operating_hours", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	courtId: uuid("court_id").notNull(),
	dayOfWeek: integer("day_of_week").notNull(),
	opensHour: integer("opens_hour").notNull(),
	closesHour: integer("closes_hour").notNull(),
}, (table) => [
	index("court_operating_hours_court_id_idx").using("btree", table.courtId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.courtId],
			foreignColumns: [courts.id],
			name: "court_operating_hours_court_id_fkey"
		}).onDelete("cascade"),
	unique("court_operating_hours_unique_day").on(table.courtId, table.dayOfWeek),
	check("court_operating_hours_closes_hour_check", sql`(closes_hour > 0) AND (closes_hour <= 24)`),
	check("court_operating_hours_day_of_week_check", sql`(day_of_week >= 0) AND (day_of_week <= 6)`),
	check("court_operating_hours_opens_hour_check", sql`(opens_hour >= 0) AND (opens_hour < 24)`),
	check("court_operating_hours_order", sql`closes_hour > opens_hour`),
]);

export const bookings = pgTable("bookings", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	courtId: uuid("court_id").notNull(),
	branchId: uuid("branch_id").notNull(),
	playerId: uuid("player_id").notNull(),
	startsAt: timestamp("starts_at", { withTimezone: true, mode: 'string' }).notNull(),
	endsAt: timestamp("ends_at", { withTimezone: true, mode: 'string' }).notNull(),
	// TODO: failed to parse database type 'tstzrange'
	slot: unknown("slot").generatedAlwaysAs(sql`tstzrange(starts_at, ends_at, '[)'::text)`),
	status: bookingStatus().default('pending_payment').notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	courtFeeCentavos: integer("court_fee_centavos").notNull(),
	transactionFeeCentavos: integer("transaction_fee_centavos").default(0).notNull(),
	totalChargedCentavos: integer("total_charged_centavos").notNull(),
	platformFeeCentavos: integer("platform_fee_centavos").notNull(),
	processorFeeCentavos: integer("processor_fee_centavos").default(0).notNull(),
	ownerNetCentavos: integer("owner_net_centavos").notNull(),
	feeConfigSnapshot: jsonb("fee_config_snapshot").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("bookings_branch_id_idx").using("btree", table.branchId.asc().nullsLast().op("uuid_ops")),
	index("bookings_court_id_idx").using("btree", table.courtId.asc().nullsLast().op("uuid_ops")),
	index("bookings_court_starts_at_idx").using("btree", table.courtId.asc().nullsLast().op("timestamptz_ops"), table.startsAt.asc().nullsLast().op("timestamptz_ops")),
	index("bookings_expiring_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'pending_payment'::booking_status)`),
	index("bookings_player_id_idx").using("btree", table.playerId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.branchId],
			foreignColumns: [branches.id],
			name: "bookings_branch_id_fkey"
		}),
	foreignKey({
			columns: [table.courtId],
			foreignColumns: [courts.id],
			name: "bookings_court_id_fkey"
		}),
	foreignKey({
			columns: [table.playerId],
			foreignColumns: [profiles.id],
			name: "bookings_player_id_fkey"
		}),
	check("bookings_court_fee_centavos_check", sql`court_fee_centavos >= 0`),
	check("bookings_hold_has_expiry", sql`(status <> 'pending_payment'::booking_status) OR (expires_at IS NOT NULL)`),
	check("bookings_platform_fee_centavos_check", sql`platform_fee_centavos >= 0`),
	check("bookings_processor_fee_centavos_check", sql`processor_fee_centavos >= 0`),
	check("bookings_time_order", sql`ends_at > starts_at`),
	check("bookings_total_charged_centavos_check", sql`total_charged_centavos >= 0`),
	check("bookings_transaction_fee_centavos_check", sql`transaction_fee_centavos >= 0`),
]);

export const platformSettings = pgTable("platform_settings", {
	id: boolean().default(true).primaryKey().notNull(),
	defaultPlatformFeeMode: platformFeeMode("default_platform_fee_mode").default('percentage').notNull(),
	defaultPlatformFeeValue: integer("default_platform_fee_value").default(1000).notNull(),
	defaultProcessorFeeBearer: processorFeeBearer("default_processor_fee_bearer").default('platform').notNull(),
	holdDurationMinutes: integer("hold_duration_minutes").default(15).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	check("platform_settings_fee_value_positive", sql`default_platform_fee_value > 0`),
	check("platform_settings_hold_positive", sql`hold_duration_minutes > 0`),
	check("platform_settings_singleton", sql`CHECK (id)`),
]);

export const processorRates = pgTable("processor_rates", {
	paymentMethod: text("payment_method").primaryKey().notNull(),
	percentageBps: integer("percentage_bps").notNull(),
	fixedFeeCentavos: integer("fixed_fee_centavos").default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	check("processor_rates_fixed_fee_centavos_check", sql`fixed_fee_centavos >= 0`),
	check("processor_rates_percentage_bps_check", sql`percentage_bps >= 0`),
]);

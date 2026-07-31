/**
 * Zod vehicle schema for adaptive scraper normalization (Vercel / Node).
 */
const { z } = require('zod');

const VehicleSchema = z.object({
  stockNumber: z.string().default('N/A'),
  year: z.number().int().nonnegative().default(0),
  make: z.string().default(''),
  model: z.string().default(''),
  trim: z.string().default(''),
  price: z.number().nonnegative().default(0),
  mileage: z.number().nonnegative().default(0),
  exteriorColor: z.string().default(''),
  link: z.string().default(''),
  imageUrl: z.string().default(''),
  vin: z.string().min(10),
});

module.exports = { VehicleSchema };

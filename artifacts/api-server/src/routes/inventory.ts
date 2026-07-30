/**
 * Inventory parse / sanitize routes for the Node api-server Express app.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import {
  parseInventoryText,
  parseVehiclesFromHtml,
  sanitizeInventoryList,
  sanitizeVehicleRecord,
} from "../utils/inventoryParser";

const router: IRouter = Router();

/** POST /api/inventory/parse — scrub a raw scraper blob into structured fields. */
router.post("/inventory/parse", (req: Request, res: Response) => {
  const raw =
    typeof req.body?.raw === "string"
      ? req.body.raw
      : typeof req.body?.text === "string"
        ? req.body.text
        : typeof req.body?.html === "string"
          ? req.body.html
          : "";

  if (!raw.trim()) {
    res.status(400).json({
      success: false,
      error: "raw, text, or html body field is required.",
    });
    return;
  }

  const looksLikePage =
    typeof req.body?.html === "string" ||
    /<(?:div|li|article|section|html|body)\b/i.test(raw);

  if (looksLikePage && (req.body?.multi === true || typeof req.body?.html === "string")) {
    const vehicles = parseVehiclesFromHtml(raw);
    res.status(200).json({
      success: true,
      vehicles,
      count: vehicles.length,
      parsed: vehicles[0] || parseInventoryText(raw),
    });
    return;
  }

  const parsed = parseInventoryText(raw);
  const vehicle =
    req.body?.vehicle && typeof req.body.vehicle === "object"
      ? sanitizeVehicleRecord(req.body.vehicle as Record<string, unknown>, raw)
      : sanitizeVehicleRecord(parsed as unknown as Record<string, unknown>, raw);

  res.status(200).json({
    success: true,
    parsed,
    vehicle,
  });
});

/** POST /api/inventory/sanitize — normalize an array of vehicle records. */
router.post("/inventory/sanitize", (req: Request, res: Response) => {
  const rows = Array.isArray(req.body?.inventory)
    ? req.body.inventory
    : Array.isArray(req.body?.vehicles)
      ? req.body.vehicles
      : Array.isArray(req.body)
        ? req.body
        : null;

  if (!rows) {
    res.status(400).json({
      success: false,
      error: "Provide inventory/vehicles array in the JSON body.",
    });
    return;
  }

  const inventory = sanitizeInventoryList(rows as Array<Record<string, unknown>>);
  res.status(200).json({
    success: true,
    inventory,
    count: inventory.length,
  });
});

export default router;

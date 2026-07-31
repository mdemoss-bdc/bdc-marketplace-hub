import { Router, type IRouter } from "express";
import healthRouter from "./health";
import inventoryRouter from "./inventory";
import authRouter from "./auth";
import facebookRouter from "./facebook";
import marketplaceRouter from "./marketplace";
import syncRouter from "./sync";
import catalogRouter from "./catalog";
import tiktokVerificationRouter from "./tiktok-verification";
import leadsRouter from "./leads";

const router: IRouter = Router();

router.use(tiktokVerificationRouter);
router.use(healthRouter);
router.use(catalogRouter);
router.use(syncRouter);
router.use(facebookRouter);
router.use(authRouter);
router.use(inventoryRouter);
router.use(marketplaceRouter);
router.use(leadsRouter);

export default router;

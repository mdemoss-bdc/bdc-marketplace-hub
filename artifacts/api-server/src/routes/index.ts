import { Router, type IRouter } from "express";
import healthRouter from "./health";
import inventoryRouter from "./inventory";
import authRouter from "./auth";
import facebookRouter from "./facebook";
import marketplaceRouter from "./marketplace";

const router: IRouter = Router();

router.use(healthRouter);
router.use(facebookRouter);
router.use(authRouter);
router.use(inventoryRouter);
router.use(marketplaceRouter);

export default router;

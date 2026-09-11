import { accountingRouter as coreAccountingRouter } from './accounting-core.router';
import { accountClassificationRouter } from './account-classification.router';

export {
  AccountingService,
  AccountingValidationError,
  AccountingNotFoundError,
  AccountingConflictError,
} from './accounting-core.router';

export const accountingRouter=coreAccountingRouter;
accountingRouter.use(accountClassificationRouter);

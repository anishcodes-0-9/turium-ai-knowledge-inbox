import { Router } from 'express';
import { parseOrThrow } from '../middleware/validate.js';
import { queryBodySchema } from './schemas.js';
import { answerQuestion, type QueryDeps } from '../services/queryService.js';

/** POST /query — `{question, topK?, minScore?}` → answer + validated citations. */
export function queryRouter(deps: QueryDeps): Router {
  const router = Router();
  router.post('/query', async (req, res) => {
    const body = parseOrThrow(queryBodySchema, req.body, 'query request');
    req.log.info({ questionChars: body.question.length, topK: body.topK, minScore: body.minScore }, 'query received');
    const result = await answerQuestion(deps, body, req.log);
    res.json(result);
  });
  return router;
}

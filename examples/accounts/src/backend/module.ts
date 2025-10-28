import { initContract } from '@ts-rest/core';
import { createModule, fromTsRestRouter, type RequestContext, type SSRContext } from '@webstir-io/module-contract';
import { z } from 'zod';

type Account = {
  id: string;
  email: string;
};

type AccountsDatabase = {
  accounts: {
    list: () => Promise<Account[]>;
    findById: (id: string) => Promise<Account | undefined>;
  };
};

type AccountsContext = RequestContext<unknown, unknown, unknown, unknown, AccountsDatabase>;

const c = initContract();

const accountSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email()
});

const router = c.router({
  list: c.query({
    path: '/accounts',
    method: 'GET',
    responses: {
      200: z.object({ data: z.array(accountSchema) })
    }
  }),
  detail: c.query({
    path: '/accounts/:id',
    method: 'GET',
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: accountSchema,
      404: z.null()
    }
  })
});

const routeSpecs = fromTsRestRouter<AccountsContext>({
  router,
  baseName: 'accounts',
  createRoute: ({ keyPath }) => ({
    handler: async (ctx) => {
      if (keyPath.at(-1) === 'detail') {
        const row = await ctx.db.accounts.findById(ctx.params.id);
        return row
          ? { status: 200, body: row }
          : { status: 404, errors: [{ code: 'not_found', message: 'Account not found' }] };
      }

      const rows = await ctx.db.accounts.list();
      return { status: 200, body: { data: rows } };
    }
  })
});

export const module = createModule<AccountsContext, SSRContext>({
  manifest: {
    contractVersion: '1.0.0',
    name: '@demo/accounts',
    version: '0.1.0',
    kind: 'backend',
    capabilities: ['db', 'auth'],
    routes: routeSpecs.map((route) => route.definition)
  },
  routes: routeSpecs
});

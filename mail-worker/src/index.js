import app from './hono/webs';
import { email } from './email/email';
import userService from './service/user-service';
import verifyRecordService from './service/verify-record-service';
import emailService from './service/email-service';
import kvObjService from './service/kv-obj-service';
import oauthService from "./service/oauth-service";
export default {
	 async fetch(req, env, ctx) {

		const url = new URL(req.url)

		if (url.pathname === '/api/webhook' || url.pathname === '/api/webhook/') {
			if (!env.WEBHOOK_FORWARD_URL) {
				return new Response('Webhook forward not configured', { status: 502 });
			}
			try {
				const target = new URL(env.WEBHOOK_FORWARD_URL);
				if (target.host === url.host) {
					return new Response('Webhook forward loop', { status: 500 });
				}
			} catch (e) {
				return new Response('Invalid WEBHOOK_FORWARD_URL', { status: 500 });
			}
			const forwardHeaders = new Headers(req.headers);
			forwardHeaders.set('X-Forwarded-Host', url.host);
			forwardHeaders.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
			return fetch(env.WEBHOOK_FORWARD_URL, {
				method: req.method,
				headers: forwardHeaders,
				body: req.body,
				redirect: 'manual'
			});
		}

		if (url.pathname.startsWith('/api/')) {
			url.pathname = url.pathname.replace('/api', '')
			req = new Request(url.toString(), req)
			return app.fetch(req, env, ctx);
		}

		 if (['/static/','/attachments/'].some(p => url.pathname.startsWith(p))) {
			 return await kvObjService.toObjResp( { env }, url.pathname.substring(1));
		 }

		return env.assets.fetch(req);
	},
	email: email,
	async scheduled(c, env, ctx) {
		await verifyRecordService.clearRecord({ env })
		await userService.resetDaySendCount({ env })
		await emailService.completeReceiveAll({ env })
		await oauthService.clearNoBindOathUser({ env })
	},
};

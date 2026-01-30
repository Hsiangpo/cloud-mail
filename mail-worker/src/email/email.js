import PostalMime from 'postal-mime';
import emailService from '../service/email-service';
import accountService from '../service/account-service';
import settingService from '../service/setting-service';
import attService from '../service/att-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { emailConst, isDel, roleConst, settingConst } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import roleService from '../service/role-service';
import verifyUtils from '../utils/verify-utils';
import r2Service from '../service/r2-service';
import userService from '../service/user-service';
import telegramService from '../service/telegram-service';

export async function email(message, env, ctx) {

	try {

		const {
			receive,
			tgChatId,
			tgBotStatus,
			forwardStatus,
			forwardEmail,
			ruleEmail,
			ruleType,
			r2Domain,
			noRecipient
		} = await settingService.query({ env });

		if (receive === settingConst.receive.CLOSE) {
			message.setReject('Service suspended');
			return;
		}


		const reader = message.raw.getReader();
		let content = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			content += new TextDecoder().decode(value);
		}

		const email = await PostalMime.parse(content);

		const account = await accountService.selectByEmailIncludeDel({ env: env }, message.to);

		if (!account && noRecipient === settingConst.noRecipient.CLOSE) {
			message.setReject('Recipient not found');
			return;
		}

		let userRow = {}

		if (account) {
			 userRow = await userService.selectById({ env: env }, account.userId);
		}

		if (account && userRow.email !== env.admin) {

			let { banEmail, banEmailType, availDomain } = await roleService.selectByUserId({ env: env }, account.userId);

			if (!roleService.hasAvailDomainPerm(availDomain, message.to)) {
				message.setReject('Mailbox disabled');
				return;
			}

			banEmail = banEmail.split(',').filter(item => item !== '');


			if (banEmail.includes('*')) {

				if (!banEmailHandler(banEmailType, message, email)) return;

			}

			for (const item of banEmail) {

				if (verifyUtils.isDomain(item)) {

					const banDomain = item.toLowerCase();
					const receiveDomain = emailUtils.getDomain(email.from.address.toLowerCase());

					if (banDomain === receiveDomain) {

						if (!banEmailHandler(banEmailType, message, email)) return;

					}

				} else {

					if (item.toLowerCase() === email.from.address.toLowerCase()) {

						if (!banEmailHandler(banEmailType, message, email)) return;

					}

				}

			}

		}


		if (!email.to) {
			email.to = [{ address: message.to, name: emailUtils.getName(message.to)}]
		}

		const toName = email.to.find(item => item.address === message.to)?.name || '';

		const params = {
			toEmail: message.to,
			toName: toName,
			sendEmail: email.from.address,
			name: email.from.name || emailUtils.getName(email.from.address),
			subject: email.subject,
			content: email.html,
			text: email.text,
			cc: email.cc ? JSON.stringify(email.cc) : '[]',
			bcc: email.bcc ? JSON.stringify(email.bcc) : '[]',
			recipient: JSON.stringify(email.to),
			inReplyTo: email.inReplyTo,
			relation: email.references,
			messageId: email.messageId,
			userId: account ? account.userId : 0,
			accountId: account ? account.accountId : 0,
			isDel: isDel.DELETE,
			status: emailConst.status.SAVING
		};

		const attachments = [];
		const cidAttachments = [];

		for (let item of email.attachments) {
			let attachment = { ...item };
			attachment.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(attachment.content) + fileUtils.getExtFileName(item.filename);
			attachment.size = item.content.length ?? item.content.byteLength;
			attachments.push(attachment);
			if (attachment.contentId) {
				cidAttachments.push(attachment);
			}
		}

		let emailRow = await emailService.receive({ env }, params, cidAttachments, r2Domain);

		attachments.forEach(attachment => {
			attachment.emailId = emailRow.emailId;
			attachment.userId = emailRow.userId;
			attachment.accountId = emailRow.accountId;
		});

		try {
			if (attachments.length > 0) {
				await attService.addAtt({ env }, attachments);
			}
		} catch (e) {
			console.error(e);
		}

		emailRow = await emailService.completeReceive({ env }, account ? emailConst.status.RECEIVE : emailConst.status.NOONE, emailRow.emailId);

		// Webhook push (optional)
		if (env.WEBHOOK_URL) {
			const payload = buildWebhookPayload(message, email, emailRow, env);
			if (payload) {
				ctx.waitUntil(sendWebhook(env, payload));
			}
		}


		if (ruleType === settingConst.ruleType.RULE) {

			const emails = ruleEmail.split(',');

			if (!emails.includes(message.to)) {
				return;
			}

		}

		//杞彂鍒癟G
		if (tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {
			await telegramService.sendEmailToBot({ env }, emailRow)
		}

		//杞彂鍒板叾浠栭偖绠?
		if (forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail) {

			const emails = forwardEmail.split(',');

			await Promise.all(emails.map(async email => {

				try {
					await message.forward(email);
				} catch (e) {
					console.error(`杞彂閭 ${email} 澶辫触锛歚, e);
				}

			}));

		}

	} catch (e) {
		console.error('閭欢鎺ユ敹寮傚父: ', e);
		throw e
	}
}

function buildWebhookPayload(message, email, emailRow, env) {
	const onlyOtp = String(env.WEBHOOK_ONLY_OTP || '').toLowerCase() === 'true';
	const otp = extractOtp(email);
	if (onlyOtp && !otp) {
		return null;
	}
	return {
		event: 'email.received',
		messageId: email.messageId,
		emailId: emailRow.emailId,
		accountId: emailRow.accountId,
		userId: emailRow.userId,
		toEmail: message.to,
		fromEmail: email.from?.address,
		subject: email.subject,
		text: email.text,
		html: email.html,
		otp,
		receivedAt: new Date().toISOString()
	};
}

function extractOtp(email) {
	const candidates = [email.subject, email.text, email.html].filter(Boolean).join(' ');
	const match = candidates.match(/\b(\d{6})\b/);
	return match ? match[1] : null;
}

async function sendWebhook(env, payload) {
	try {
		const body = JSON.stringify(payload);
		const headers = {
			'Content-Type': 'application/json',
			'X-Webhook-Event': payload.event,
			'X-Webhook-Source': 'cloud-mail'
		};
		if (env.WEBHOOK_SECRET) {
			const signature = await signBody(env.WEBHOOK_SECRET, body);
			headers['X-Webhook-Signature'] = `sha256=${signature}`;
		}
		await fetch(env.WEBHOOK_URL, {
			method: 'POST',
			headers,
			body
		});
	} catch (e) {
		console.error('Webhook push failed', e);
	}
}

async function signBody(secret, body) {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		enc.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
	return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function banEmailHandler(banEmailType, message, email) {

	if (banEmailType === roleConst.banEmailType.ALL) {
		message.setReject('Mailbox disabled');
		return false;
	}

	if (banEmailType === roleConst.banEmailType.CONTENT) {
		email.html = 'The content has been deleted';
		email.text = 'The content has been deleted';
		email.attachments = [];
	}

	return true;

}

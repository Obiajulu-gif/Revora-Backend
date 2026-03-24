import { RequestHandler, Router } from 'express';
import { NotificationPreferencesRepository } from '../db/repositories/notificationPreferencesRepository';

interface AuthenticatedRequest {
  user?: { id: string };
}

interface CreateNotificationPreferencesRouterDeps {
  requireAuth: RequestHandler;
  notificationPreferencesRepository: NotificationPreferencesRepository;
}

export const createNotificationPreferencesRouter = ({
  requireAuth,
  notificationPreferencesRepository,
}: CreateNotificationPreferencesRouterDeps): Router => {
  const router = Router();

  const toWireShape = (prefs: {
    email_notifications: boolean;
    push_notifications: boolean;
    sms_notifications: boolean;
  }) => ({
    email_notifications: prefs.email_notifications,
    push_notifications: prefs.push_notifications,
    sms_notifications: prefs.sms_notifications,
  });

  router.get('/api/users/me/notification-preferences', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const preferences = await notificationPreferencesRepository.getByUserId(userId);
      if (!preferences) {
        return res.json({
          email_notifications: true,
          push_notifications: true,
          sms_notifications: false,
        });
      }
      res.json(toWireShape(preferences));
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch notification preferences' });
    }
  });

  router.patch('/api/users/me/notification-preferences', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { email_notifications, push_notifications, sms_notifications } = req.body;

    try {
      const updated = await notificationPreferencesRepository.upsert(userId, {
        email_notifications,
        push_notifications,
        sms_notifications,
      });
      res.json(toWireShape(updated));
    } catch (error) {
      res.status(500).json({ error: 'Failed to update notification preferences' });
    }
  });

  return router;
};

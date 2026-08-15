# Fans out short email/SMS alerts based on user prefs and available contact info.
# Push (APNs/FCM/web-push) is not implemented — needs a PWA or native app.
class Notifier
  APP_HOST = ENV.fetch("APP_HOST", "https://wannawatch.app")

  class << self
    def game_invite(invite)
      inviter = invite.inviter.username.presence || "Someone"
      code = invite.game.entry_code
      url = game_url(code)
      notify(
        invite.invitee,
        category: "game_invite",
        email_subject: "#{inviter} invited you on WannaWatch",
        body: "#{inviter} invited you to a game. Code #{code}: #{url}"
      )
    end

    def game_nudge(invite)
      inviter = invite.inviter.username.presence || "Someone"
      code = invite.game.entry_code
      url = game_url(code)
      notify(
        invite.invitee,
        category: "game_nudge",
        email_subject: "#{inviter} is waiting on WannaWatch",
        body: "#{inviter} nudged you — game #{code} is ready. #{url}"
      )
    end

    def match_alert(game, movie_id = nil)
      code = game.entry_code
      url = game_url(code)
      body = if movie_id
               "You matched on WannaWatch! Open game #{code}: #{url}"
             else
               "New match in game #{code}: #{url}"
             end

      game.players.includes(:user).each do |player|
        notify(
          player.user,
          category: "match_alert",
          email_subject: "WannaWatch match — #{code}",
          body: body
        )
      end
    end

    def notify(user, category:, email_subject:, body:)
      return unless user
      return unless user.notification_category_enabled?(category)

      if user.wants_email_notifications?
        deliver_email(user, email_subject, body)
      end

      if user.wants_sms_notifications?
        TwilioSmsClient.send_sms(to: user.phone, body: body)
      end
    end

    private

    def game_url(entry_code)
      "#{APP_HOST.chomp('/')}/?entry_code=#{entry_code}"
    end

    def deliver_email(user, subject, body)
      unless ENV["SMTP_ADDRESS"].present? || Rails.env.test?
        Rails.logger.info("[Notifier] email skipped (SMTP_ADDRESS unset): to=#{user.email}")
        return
      end

      NotificationMailer.alert(user, subject, body).deliver_now
    rescue StandardError => e
      Rails.logger.warn("[Notifier] email error: #{e.class}: #{e.message}")
    end
  end
end

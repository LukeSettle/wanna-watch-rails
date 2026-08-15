class NotificationMailer < ApplicationMailer
  default from: ENV.fetch("SMTP_FROM", "WannaWatch <no-reply@wannawatch.app>")

  def alert(user, subject, body)
    @body = body
    @username = user.username
    mail(to: user.email, subject: subject)
  end
end

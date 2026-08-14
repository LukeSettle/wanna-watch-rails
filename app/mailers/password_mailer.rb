class PasswordMailer < ApplicationMailer
  default from: ENV.fetch("SMTP_FROM", "WannaWatch <no-reply@wannawatch.app>")

  def reset(user, reset_url)
    @username = user.username
    @reset_url = reset_url
    mail(to: user.email, subject: "Reset your WannaWatch password")
  end
end

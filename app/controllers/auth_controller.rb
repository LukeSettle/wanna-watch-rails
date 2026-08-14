class AuthController < ApiController
  include ActionController::Cookies

  SESSION_COOKIE = :ww_session
  RESET_TOKEN_TTL = 30.minutes
  MIN_PASSWORD_LENGTH = 8

  def me
    user = current_session_user
    if user
      render json: user_with_email(user), status: :ok
    else
      render json: { error: "Not logged in" }, status: :unauthorized
    end
  end

  # Attaches an email + password to the current guest user (keeping their
  # games and likes), or creates a fresh user when there is no guest yet.
  def register
    email = params[:email].to_s.strip.downcase
    password = params[:password].to_s
    return render_error("Enter a valid email.") unless email.match?(URI::MailTo::EMAIL_REGEXP)
    return render_error("Password must be at least #{MIN_PASSWORD_LENGTH} characters.") if password.length < MIN_PASSWORD_LENGTH
    return render_error("That email already has an account — log in instead.") if User.exists?(email: email)

    user = User.find_by(id: params[:user_id], email: nil) || User.new(device_id: SecureRandom.uuid)
    user.username = params[:username] if params[:username].present?
    user.email = email
    user.password = password

    if user.save
      set_session(user)
      render json: user_with_email(user), status: :ok
    else
      render_error(user.errors.full_messages.first || "Could not create the account.")
    end
  end

  def login
    user = User.find_by(email: params[:email].to_s.strip.downcase)

    if user&.password_digest.present? && user.authenticate(params[:password].to_s)
      set_session(user)
      render json: user_with_email(user), status: :ok
    else
      render json: { error: "Wrong email or password." }, status: :unauthorized
    end
  end

  def logout
    cookies.delete(SESSION_COOKIE)
    render json: {}, status: :ok
  end

  def forgot
    unless smtp_configured?
      return render json: { error: "Password reset emails aren't set up on the server yet." }, status: :service_unavailable
    end

    user = User.find_by(email: params[:email].to_s.strip.downcase)
    if user
      raw_token = SecureRandom.urlsafe_base64(24)
      user.update!(reset_token_digest: digest(raw_token), reset_token_sent_at: Time.current)
      PasswordMailer.reset(user, "#{request.base_url}/?reset_token=#{raw_token}").deliver_now
    end

    # Same response whether or not the email exists.
    render json: { sent: true }, status: :ok
  end

  def reset
    user = User.where("reset_token_sent_at > ?", RESET_TOKEN_TTL.ago)
               .find_by(reset_token_digest: digest(params[:token].to_s))
    return render_error("That reset link is invalid or has expired.") unless user

    password = params[:password].to_s
    return render_error("Password must be at least #{MIN_PASSWORD_LENGTH} characters.") if password.length < MIN_PASSWORD_LENGTH

    user.update!(password: password, reset_token_digest: nil, reset_token_sent_at: nil)
    set_session(user)
    render json: user_with_email(user), status: :ok
  end

  private

  def current_session_user
    user_id = cookies.signed[SESSION_COOKIE]
    User.find_by(id: user_id) if user_id
  end

  def set_session(user)
    cookies.signed[SESSION_COOKIE] = {
      value: user.id,
      expires: 1.year,
      httponly: true,
      secure: Rails.env.production?,
      same_site: :lax
    }
  end

  def user_with_email(user)
    user.as_json.merge("email" => user.email)
  end

  def render_error(message)
    render json: { error: message }, status: :unprocessable_entity
  end

  def digest(token)
    Digest::SHA256.hexdigest(token)
  end

  def smtp_configured?
    ENV["SMTP_ADDRESS"].present?
  end
end

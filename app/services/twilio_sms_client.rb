# Thin Twilio REST wrapper. No-ops (and logs) when TWILIO_* env is missing.
require "net/http"
require "uri"

class TwilioSmsClient
  class << self
    def configured?
      ENV["TWILIO_ACCOUNT_SID"].present? &&
        ENV["TWILIO_AUTH_TOKEN"].present? &&
        ENV["TWILIO_FROM_NUMBER"].present?
    end

    def send_sms(to:, body:)
      unless configured?
        Rails.logger.info("[TwilioSmsClient] skipped (not configured): to=#{to} body=#{body.to_s.truncate(80)}")
        return false
      end

      uri = URI("https://api.twilio.com/2010-04-01/Accounts/#{ENV['TWILIO_ACCOUNT_SID']}/Messages.json")
      request = Net::HTTP::Post.new(uri)
      request.basic_auth(ENV["TWILIO_ACCOUNT_SID"], ENV["TWILIO_AUTH_TOKEN"])
      request.set_form_data("To" => to, "From" => ENV["TWILIO_FROM_NUMBER"], "Body" => body)

      response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: true) do |http|
        http.request(request)
      end

      unless response.is_a?(Net::HTTPSuccess)
        Rails.logger.warn("[TwilioSmsClient] failed #{response.code}: #{response.body.to_s.truncate(200)}")
        return false
      end

      true
    rescue StandardError => e
      Rails.logger.warn("[TwilioSmsClient] error: #{e.class}: #{e.message}")
      false
    end
  end
end

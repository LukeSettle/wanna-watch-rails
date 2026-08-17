class ApplicationController < ActionController::Base
  def home
    render layout: false
  end
end

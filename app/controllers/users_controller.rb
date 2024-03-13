class UsersController < ApplicationController
  def upsert
    user = User.find_or_initialize_by(device_id: user_params[:device_id])

    if user.update user_params
      render json: user, status: :ok
    else
      render json: user.errors, status: :unprocessable_entity
    end
  end

  def find_by_device_id
    user = User.find_by device_id: params[:device_id]

    if user
      render json: user, status: :ok
    else
      render json: { error: 'User not found' }, status: :not_found
    end
  end

  private

  def user_params
    params.require(:user).permit(:device_id, :username)
  end
end

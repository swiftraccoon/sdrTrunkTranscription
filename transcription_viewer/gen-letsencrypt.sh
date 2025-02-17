#!/usr/bin/env bash
#
# generate_letsencrypt_cert.sh
#
# This script automates the process of obtaining a Let's Encrypt certificate
# for a specified domain on Debian/Ubuntu-like systems.
#
# Usage: sudo ./generate_letsencrypt_cert.sh <domain>
#
# Example: sudo ./generate_letsencrypt_cert.sh sdr.spindale.host
#
# Author: [Your Name]
# Date: 2024-12-24
# ------------------------------------------------------------------------------

# -----------------------------------
# GLOBAL VARIABLES
# -----------------------------------
DOMAIN="sdr.spindale.host"
EMAIL="admin@spindale.host"  # Change this to your real email for important notifications
CERTBOT_BINARY="$(command -v certbot || true)"

# -----------------------------------
# FUNCTIONS
# -----------------------------------

# Show usage
usage() {
  echo "Usage: $0 <domain>"
  echo "Example: $0 sdr.spindale.host"
  exit 1
}

# Check if the script is running as root or via sudo
check_root() {
  if [[ "$EUID" -ne 0 ]]; then
    echo "ERROR: This script must be run as root or under sudo."
    exit 1
  fi
}

# Check domain is provided as argument
check_args() {
  if [ -z "$DOMAIN" ]; then
    echo "ERROR: Domain not provided."
    usage
  fi
}

# Install certbot if not present
install_certbot() {
  if [ -z "$CERTBOT_BINARY" ]; then
    echo "Certbot not found. Installing..."
    apt-get update -y
    apt-get install -y certbot
  else
    echo "Certbot is already installed at $CERTBOT_BINARY."
  fi
}

# Obtain the certificate using the standalone plugin
obtain_certificate() {
  echo "Attempting to obtain certificate for domain: $DOMAIN"

  # Stop any service that might be using port 80 if needed (optional)
  # systemctl stop nginx

  certbot certonly \
    --standalone \
    --agree-tos \
    --non-interactive \
    --email "$EMAIL" \
    -d "$DOMAIN"

  # You could also use webroot if you have a running webserver:
  # certbot certonly --webroot -w /var/www/html -d "$DOMAIN" --agree-tos --non-interactive --email "$EMAIL"

  # Resume your service if you stopped it (optional)
  # systemctl start nginx
}

# Check if certificate already exists
check_existing_cert() {
  if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    echo "A certificate for $DOMAIN already exists in /etc/letsencrypt/live/$DOMAIN."
    echo "Skipping issuance unless you want to force renewal."
    exit 0
  fi
}

# (Optional) Setup auto-renewal via cron or systemd
# By default, Certbot installs a systemd timer that renews automatically.
# You can verify or customize as needed.
setup_auto_renew() {
  # This is typically done automatically by Certbot on systemd-based distros.
  # If you want to handle it manually via cron:
  # echo "0 3 * * * /usr/bin/certbot renew --quiet" >> /etc/crontab
  echo "Auto-renewal is generally configured by default on Debian with systemd."
}

# -----------------------------------
# MAIN SCRIPT
# -----------------------------------

# Check script is running with appropriate privileges
check_root

# Check usage
check_args

# Install certbot if missing
install_certbot

# Check if a cert for this domain already exists
check_existing_cert

# Obtain the certificate
obtain_certificate

# Setup auto-renew (if desired/needed)
setup_auto_renew

# Success message
echo "Certificate for $DOMAIN has been obtained successfully."
echo "Your certificate files are located in /etc/letsencrypt/live/$DOMAIN/"
echo "Done."
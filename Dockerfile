FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy application source code
COPY . .

# Expose the application port
EXPOSE 34343

# Start the application using the script defined in package.json
CMD ["npm", "run", "start"]

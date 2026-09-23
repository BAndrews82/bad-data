# Step 1: Base image
FROM node:20-alpine

# Step 2: Set working directory
WORKDIR /app

# Step 3: Copy dependency manifests
COPY package*.json ./

# Step 4: Install dependencies
RUN npm ci --only=production

# Step 5: Copy application source code
COPY . .

# Step 6: Expose application port
EXPOSE 3000

# Step 7: Environment defaults
ENV PORT=3000
ENV NODE_ENV=production

# Step 8: Start application
CMD ["node", "server.js"]

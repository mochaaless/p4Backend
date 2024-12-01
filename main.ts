import { MongoClient, ObjectId } from "mongodb";
import {
  fromModelToProduct,
  fromModelToCart,
  fromModelToOrder,
} from "./utils.ts";
import { UserModel, ProductModel, CartModel, OrderModel } from "./types.ts";

const MONGO_URL = Deno.env.get("MONGO_URL");
if (!MONGO_URL) {
  console.error("MONGO_URL is not set");
  Deno.exit(1);
}

const client = new MongoClient(MONGO_URL);
await client.connect();
console.info("Connected to MongoDB");

const db = client.db("shop");
const usersCollection = db.collection<UserModel>("users");
const productsCollection = db.collection<ProductModel>("products");
const cartsCollection = db.collection<CartModel>("carts");
const ordersCollection = db.collection<OrderModel>("orders");

const handler = async (req: Request): Promise<Response> => {
  const method = req.method;
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/users") {
    if (method === "POST") {
      const user = await req.json();
      if (!user.name || !user.email || !user.password) {
        return new Response(JSON.stringify({ error: "Missing user fields" }), { status: 400 });
      }
      const existUser = await usersCollection.findOne({ email: user.email });
      if (existUser) {
        return new Response(JSON.stringify({ error: "User already exists" }), { status: 409 });
      }
      const { insertedId } = await usersCollection.insertOne(user);
      return new Response(
        JSON.stringify({ id: insertedId.toString(), ...user }),
        { status: 201 }
      );
    }

    if (method === "GET") {
      const users = await usersCollection.find().toArray();
      return new Response(
        JSON.stringify(users.map((u) => ({ id: u._id!.toString(), name: u.name, email: u.email }))),
        { status: 200 }
      );
    }
  }

  if (path.startsWith("/products")) {
    const id = path.split("/")[2];
    if (method === "GET") {
      const products = await productsCollection.find().toArray();
      return new Response(
        JSON.stringify(products.map(fromModelToProduct)),
        { status: 200 }
      );
    }

    if (method === "POST") {
      const product = await req.json();
      if (!product.name || !product.price || typeof product.stock !== "number") {
        return new Response("Bad request", { status: 400 });
      }
      const { insertedId } = await productsCollection.insertOne(product);
      return new Response(
        JSON.stringify({ id: insertedId.toString(), ...product }),
        { status: 201 }
      );
    }

    if (method === "PUT" && id) {
      const updates = await req.json();
      const result = await productsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updates }
      );
      if (result.matchedCount === 0) {
        return new Response("Product not found", { status: 404 });
      }
      const updatedProduct = await productsCollection.findOne({ _id: new ObjectId(id) });
      return new Response(JSON.stringify(fromModelToProduct(updatedProduct!)), { status: 200 });
    }

    if (method === "DELETE" && id) {
      const inUse = await cartsCollection.findOne({ "products.productId": new ObjectId(id) }) ||
                    await ordersCollection.findOne({ "products.productId": new ObjectId(id) });

      if (inUse) {
        return new Response(
          JSON.stringify({ error: "Product is in use in carts or orders" }),
          { status: 400 }
        );
      }

      const result = await productsCollection.deleteOne({ _id: new ObjectId(id) });
      if (result.deletedCount === 0) {
        return new Response("Product not found", { status: 404 });
      }
      return new Response("Product deleted successfully", { status: 200 });
    }
  }

  if (path.startsWith("/carts")) {
    const userId = url.searchParams.get("userId");
    if (!userId) {
      return new Response("User ID is required", { status: 400 });
    }

    if (method === "GET") {
      const cart = await cartsCollection.findOne({ userId: new ObjectId(userId) });
      if (!cart) {
        return new Response("Cart not found", { status: 404 });
      }
      const detailedCart = await fromModelToCart(cart, productsCollection);
      return new Response(JSON.stringify(detailedCart), { status: 200 });
    }

    if (method === "POST") {
      const { productId, quantity } = await req.json();
      if (!productId || !quantity) {
        return new Response("Missing product or quantity", { status: 400 });
      }

      const product = await productsCollection.findOne({ _id: new ObjectId(productId) });
      if (!product || product.stock < quantity) {
        return new Response("Product not available in requested quantity", { status: 400 });
      }

      await cartsCollection.updateOne(
        { userId: new ObjectId(userId) },
        { $push: { products: { productId: new ObjectId(productId), quantity } } },
        { upsert: true }
      );

      const updatedCart = await cartsCollection.findOne({ userId: new ObjectId(userId) });
      const detailedCart = await fromModelToCart(updatedCart!, productsCollection);
      return new Response(JSON.stringify(detailedCart), { status: 201 });
    }

    if (method === "DELETE") {
      const productId = url.searchParams.get("productId");
      if (productId) {
        await cartsCollection.updateOne(
          { userId: new ObjectId(userId) },
          { $pull: { products: { productId: new ObjectId(productId) } } }
        );
        return new Response("Product removed from cart", { status: 200 });
      } else {
        await cartsCollection.deleteOne({ userId: new ObjectId(userId) });
        return new Response("Cart emptied", { status: 200 });
      }
    }
  }

  if (path === "/orders") {
    const userId = url.searchParams.get("userId");
    if (!userId) {
      return new Response("User ID is required", { status: 400 });
    }

    if (method === "POST") {
      const cart = await cartsCollection.findOne({ userId: new ObjectId(userId) });
      if (!cart || cart.products.length === 0) {
        return new Response("Cart is empty", { status: 400 });
      }

      const products = await Promise.all(
        cart.products.map(async (p) => {
          const product = await productsCollection.findOne({ _id: p.productId });
          if (!product || product.stock < p.quantity) {
            throw new Error("Insufficient stock");
          }
          return {
            productId: p.productId,
            quantity: p.quantity,
            price: product.price * p.quantity,
          };
        })
      );

      const total = products.reduce((sum, p) => sum + p.price, 0);
      const order = { userId: new ObjectId(userId), products, total, orderDate: new Date() };
      await ordersCollection.insertOne(order);
      await cartsCollection.deleteOne({ userId: new ObjectId(userId) });

      await Promise.all(
        products.map((p) =>
          productsCollection.updateOne(
            { _id: p.productId },
            { $inc: { stock: -p.quantity } }
          )
        )
      );

      return new Response("Order created successfully", { status: 201 });
    }

    if (method === "GET") {
      const orders = await ordersCollection.find({ userId: new ObjectId(userId) }).toArray();
      return new Response(JSON.stringify(orders.map(fromModelToOrder)), { status: 200 });
    }
  }

  return new Response("Endpoint not found", { status: 404 });
};

Deno.serve({ port: 3000 }, handler);

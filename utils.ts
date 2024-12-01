import { ProductModel, Product, CartModel, Cart, OrderModel, Order } from "./types.ts";
import { ObjectId } from "mongodb";

export const fromModelToProduct = (product: ProductModel): Product => ({
  id: product._id!.toString(),
  name: product.name,
  description: product.description,
  price: product.price,
  stock: product.stock,
});

export const fromModelToCart = async (cart: CartModel, productsCollection: any): Promise<Cart> => {
  const products = await Promise.all(
    cart.products.map(async (p) => {
      const product = await productsCollection.findOne({ _id: p.productId });
      return {
        productId: p.productId.toString(),
        name: product.name,
        quantity: p.quantity,
        price: product.price * p.quantity,
      };
    })
  );
  return {
    id: cart._id!.toString(),
    userId: cart.userId.toString(),
    products,
  };
};

export const fromModelToOrder = (order: OrderModel): Order => ({
  id: order._id!.toString(),
  userId: order.userId.toString(),
  products: order.products.map((p) => ({
    productId: p.productId.toString(),
    name: p.productId.toString(), // Replace with lookup if necessary
    quantity: p.quantity,
    price: p.price,
  })),
  total: order.total,
  orderDate: order.orderDate.toISOString(),
});

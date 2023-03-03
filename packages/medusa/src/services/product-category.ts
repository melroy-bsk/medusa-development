import { isDefined, MedusaError } from "medusa-core-utils"
import { EntityManager } from "typeorm"
import { TransactionBaseService } from "../interfaces"
import { ProductCategory } from "../models"
import { ProductCategoryRepository } from "../repositories/product-category"
import {
  FindConfig,
  QuerySelector,
  TreeQuerySelector,
  Selector,
} from "../types/common"
import { buildQuery } from "../utils"
import { EventBusService } from "."
import {
  CreateProductCategoryInput,
  UpdateProductCategoryInput,
} from "../types/product-category"

type InjectedDependencies = {
  manager: EntityManager
  eventBusService: EventBusService
  productCategoryRepository: typeof ProductCategoryRepository
}

/**
 * Provides layer to manipulate product categories.
 */
class ProductCategoryService extends TransactionBaseService {
  protected readonly productCategoryRepo_: typeof ProductCategoryRepository
  protected readonly eventBusService_: EventBusService

  static Events = {
    CREATED: "product-category.created",
    UPDATED: "product-category.updated",
    DELETED: "product-category.deleted",
  }

  constructor({
    productCategoryRepository,
    eventBusService,
  }: InjectedDependencies) {
    // eslint-disable-next-line prefer-rest-params
    super(arguments[0])

    this.eventBusService_ = eventBusService
    this.productCategoryRepo_ = productCategoryRepository
  }

  /**
   * Lists product category based on the provided parameters and includes the count of
   * product category that match the query.
   * @return an array containing the product category as
   *   the first element and the total count of product category that matches the query
   *   as the second element.
   */
  async listAndCount(
    selector: TreeQuerySelector<ProductCategory>,
    config: FindConfig<ProductCategory> = {
      skip: 0,
      take: 100,
      order: { created_at: "DESC" },
    },
    treeSelector: QuerySelector<ProductCategory> = {}
  ): Promise<[ProductCategory[], number]> {
    const includeDescendantsTree = selector.include_descendants_tree
    delete selector.include_descendants_tree

    const productCategoryRepo = this.activeManager_.withRepository(
      this.productCategoryRepo_
    )

    const selector_ = { ...selector }
    let q: string | undefined

    if ("q" in selector_) {
      q = selector_.q
      delete selector_.q
    }

    const query = buildQuery(selector_, config)

    let [productCategories, count] =
      await productCategoryRepo.getFreeTextSearchResultsAndCount(
        query,
        q,
        treeSelector
      )

    if (includeDescendantsTree) {
      productCategories = await Promise.all(
        productCategories.map(async (productCategory) =>
          productCategoryRepo.findDescendantsTree(productCategory)
        )
      )
    }

    return [productCategories, count]
  }

  /**
   * Retrieves a product category by id.
   * @param productCategoryId - the id of the product category to retrieve.
   * @param config - the config of the product category to retrieve.
   * @return the product category.
   */
  async retrieve(
    productCategoryId: string,
    config: FindConfig<ProductCategory> = {},
    selector: Selector<ProductCategory> = {}
  ): Promise<ProductCategory> {
    if (!isDefined(productCategoryId)) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `"productCategoryId" must be defined`
      )
    }

    const selectors = Object.assign({ id: productCategoryId }, selector)
    const query = buildQuery(selectors, config)
    const productCategoryRepo = this.activeManager_.withRepository(
      this.productCategoryRepo_
    )

    const productCategory = await productCategoryRepo.findOne(query)

    if (!productCategory) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `ProductCategory with id: ${productCategoryId} was not found`
      )
    }

    // Returns the productCategory with all of its descendants until the last child node
    const productCategoryTree = await productCategoryRepo.findDescendantsTree(
      productCategory
    )

    return productCategoryTree
  }

  /**
   * Creates a product category
   * @param productCategoryInput - parameters to create a product category
   * @return created product category
   */
  async create(
    productCategoryInput: CreateProductCategoryInput
  ): Promise<ProductCategory> {
    return await this.atomicPhase_(async (manager) => {
      const pcRepo = manager.withRepository(this.productCategoryRepo_)

      await this.transformParentIdToEntity(productCategoryInput)

      let productCategory = pcRepo.create(productCategoryInput)
      productCategory = await pcRepo.save(productCategory)

      await this.eventBusService_
        .withTransaction(manager)
        .emit(ProductCategoryService.Events.CREATED, {
          id: productCategory.id,
        })

      return productCategory
    })
  }

  /**
   * Updates a product category
   * @param productCategoryId - id of product category to update
   * @param productCategoryInput - parameters to update in product category
   * @return updated product category
   */
  async update(
    productCategoryId: string,
    productCategoryInput: UpdateProductCategoryInput
  ): Promise<ProductCategory> {
    return await this.atomicPhase_(async (manager) => {
      const productCategoryRepo = manager.withRepository(
        this.productCategoryRepo_
      )

      await this.transformParentIdToEntity(productCategoryInput)

      let productCategory = await this.retrieve(productCategoryId)

      for (const key in productCategoryInput) {
        if (isDefined(productCategoryInput[key])) {
          productCategory[key] = productCategoryInput[key]
        }
      }

      productCategory = await productCategoryRepo.save(productCategory)

      await this.eventBusService_
        .withTransaction(manager)
        .emit(ProductCategoryService.Events.UPDATED, {
          id: productCategory.id,
        })

      return productCategory
    })
  }

  /**
   * Deletes a product category
   *
   * @param productCategoryId is the id of the product category to delete
   * @return a promise
   */
  async delete(productCategoryId: string): Promise<void> {
    return await this.atomicPhase_(async (manager) => {
      const productCategoryRepository: typeof ProductCategoryRepository =
        manager.withRepository(this.productCategoryRepo_)

      const productCategory = await this.retrieve(productCategoryId, {
        relations: ["category_children"],
      }).catch((err) => void 0)

      if (!productCategory) {
        return
      }

      if (productCategory.category_children.length > 0) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          `Deleting ProductCategory (${productCategoryId}) with category children is not allowed`
        )
      }

      await productCategoryRepository.delete(productCategory.id)

      await this.eventBusService_
        .withTransaction(manager)
        .emit(ProductCategoryService.Events.DELETED, {
          id: productCategory.id,
        })
    })
  }

  /**
   * Add a batch of product to a product category
   * @param productCategoryId - The id of the product category on which to add the products
   * @param productIds - The products ids to attach to the product category
   * @return the product category on which the products have been added
   */
  async addProducts(
    productCategoryId: string,
    productIds: string[]
  ): Promise<void> {
    return await this.atomicPhase_(async (manager) => {
      const productCategoryRepository = manager.withRepository(
        this.productCategoryRepo_
      )

      await productCategoryRepository.addProducts(productCategoryId, productIds)
    })
  }

  /**
   * Remove a batch of product from a product category
   * @param productCategoryId - The id of the product category on which to remove the products
   * @param productIds - The products ids to remove from the product category
   * @return the product category on which the products have been removed
   */
  async removeProducts(
    productCategoryId: string,
    productIds: string[]
  ): Promise<void> {
    return await this.atomicPhase_(async (manager) => {
      const productCategoryRepository = manager.withRepository(
        this.productCategoryRepo_
      )

      await productCategoryRepository.removeProducts(
        productCategoryId,
        productIds
      )
    })
  }

  /**
   * Accepts an input object and transforms product_category_id
   * into product_category entity.
   * @param productCategoryInput - params used to create/update
   * @return transformed productCategoryInput
   */
  protected async transformParentIdToEntity(
    productCategoryInput:
      | CreateProductCategoryInput
      | UpdateProductCategoryInput
  ): Promise<CreateProductCategoryInput | UpdateProductCategoryInput> {
    // Typeorm only updates mpath when the category entity of the parent
    // is passed into create/save. For this reason, everytime we create a
    // category, we must fetch the entity and push to create
    const parentCategoryId = productCategoryInput.parent_category_id

    if (!parentCategoryId) {
      return productCategoryInput
    }

    const parentCategory = await this.retrieve(parentCategoryId)

    productCategoryInput.parent_category = parentCategory
    delete productCategoryInput.parent_category_id

    return productCategoryInput
  }
}

export default ProductCategoryService